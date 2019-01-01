let kafka = require('kafka-node'),
    ConsumerOffsetOutOfSyncChecker = require('../healthCheckers/consumerOffsetOutOfSyncChecker'),
    KafkaThrottlingManager = require('../throttling/kafkaThrottlingManager'),
    _ = require('lodash'),
    prometheusConfig = require('../prometheus/prometheus-config'),
    prometheus = require('prom-client');

module.exports = class KafkaStreamConsumer {

    init(config, logger) {
        let {
            KafkaUrl, GroupId, Topics, MessageFunction, FetchMaxBytes,
            AutoCommitIntervalMs, ThrottlingThreshold, ThrottlingCheckIntervalMs, KafkaConnectionTimeout = 10000, shouldExposeMetrics
        } = config;

        return new Promise((resolve, reject) => {
            let options = {
                kafkaHost: KafkaUrl,
                autoCommit: false,
                groupId: GroupId,
                sessionTimeout: 10000,
                protocol: ['roundrobin'],
                encoding: 'utf8',
                fetchMaxBytes: FetchMaxBytes || 1024 * 1024,
                autoCommitIntervalMs: AutoCommitIntervalMs || 5000
            };
            if (shouldExposeMetrics) {
                this.kafkaQueryHistogram = new prometheus.Histogram({
                    name: prometheusConfig.METRIC_NAMES.KAFKA_REQUEST_DURATION,
                    help: 'The duration time of processing kafka specific message',
                    labelNames: ['status', 'topic'],
                    buckets: prometheusConfig.BUCKETS.PROMETHEUS_KAFKA_DURATION_SIZES_BUCKETS
                });
                this.kafkaConsumerGroupOffset = new prometheus.Gauge({
                    name: prometheusConfig.METRIC_NAMES.CONSUMER_GROUP_OFFSET,
                    help: 'The service\'s consumer groups offset',
                    labelNames: ['topic', 'consumer_group', 'partition']
                });
            }
            let consumer = new kafka.ConsumerGroupStream(options, Topics);
            Object.assign(this, {
                logger: logger,
                configuration: config,
                isDependencyHealthy: true,
                isThirsty: true,
                commitEachMessage: _.get(config, 'CommitEachMessage', true),
                consumerEnabled: true,
                consumer: consumer
            });

            this.consumer.on('data', function (message) {
                this.lastMessage = message;
                this.logger.trace(`consumerGroupStream got message: topic: ${message.topic}, partition: ${message.partition}, offset: ${message.offset}`);
                this.kafkaThrottlingManager.handleIncomingMessage(message, this.getQueryHistogram());
            }.bind(this));

            this.consumer.on('error', function (err) {
                this.logger.error(err, 'Kafka Error');
                return reject(err);
            }.bind(this));

            this.consumer.on('close', function () {
                this.logger.info('Inner ConsumerGroupStream closed');
            }.bind(this));

            this.consumer.on('connect', function (err) {
                if (err) {
                    this.logger.error('Error when trying to connect kafka', {errorMessage: err.message});
                    return reject(err);
                } else {
                    this.logger.info('Kafka client is ready');
                    this.logger.info('topicPayloads', this.consumer.consumerGroup.topicPayloads);
                    return resolve();
                }
            }.bind(this));

            setTimeout(function () {
                return reject(new Error(`Failed to connect to kafka after ${KafkaConnectionTimeout} ms.`));
            }, KafkaConnectionTimeout);
        }).then(() => {
            // create members
            this.kafkaThrottlingManager = new KafkaThrottlingManager();
            this.kafkaThrottlingManager.init(ThrottlingThreshold, ThrottlingCheckIntervalMs,
                Topics, MessageFunction, this, this.logger);
            this.consumerOffsetOutOfSyncChecker = new ConsumerOffsetOutOfSyncChecker();
            this.consumerOffsetOutOfSyncChecker.init(this.consumer.consumerGroup,
                config.KafkaOffsetDiffThreshold, this.logger);
            if (shouldExposeMetrics) {
                this.consumerOffsetOutOfSyncChecker.registerOffsetGauge(this.getConsumerGroupDiff());
            }
        });
    }

    pause() {
        if (this.consumerEnabled) {
            this.logger.info('Suspending Kafka consumption');
            this.consumerEnabled = false;
            this.consumer.pause();
        }
    }

    resume() {
        if (!this.isDependencyHealthy) {
            this.logger.info('Not resuming consumption because dependency check returned false');
        } else if (!this.isThirsty) {
            this.logger.info('Not resuming consumption because too many messages in memory');
        } else if (!this.shuttingDown && !this.consumerEnabled) {
            this.logger.info('Resuming Kafka consumption');
            this.consumerEnabled = true;
            this.consumer.resume();
        }
    }

    closeConnection() {
        this.shuttingDown = true;
        this.logger.info('Consumer is closing connection');
        this.kafkaThrottlingManager.stop();
        return new Promise((resolve, reject) => {
            this.consumer.close(function (err) {
                if (err) {
                    this.logger.error('Error when trying to close connection with kafka', {errorMessage: err.message});
                    return reject(err);
                } else {
                    return resolve();
                }
            }.bind(this));
        });
    }

    validateOffsetsAreSynced() {
        if (!this.consumerEnabled) {
            // this.logger.info('Monitor Offset: Skipping check as the consumer is paused');
            return Promise.resolve();
        }
        return this.consumerOffsetOutOfSyncChecker.validateOffsetsAreSynced();
    }

    decreaseMessageInMemory() {
        this.logger.warn('Not supported for autoCommit: false');
    }

    setDependencyHealthy(value) {
        this.isDependencyHealthy = value;
    }

    setThirsty(value) {
        this.isThirsty = value;
    }

    getLastMessage() {
        return this.lastMessage;
    }

    getQueryHistogram() {
        return this.kafkaQueryHistogram;
    }

    getConsumerGroupDiff() {
        return this.kafkaConsumerGroupOffset;
    }

    commit(message) {
        this.consumer.commit(message, this.commitEachMessage);
    }

    on(eventName, eventHandler) {
        return this.consumer.on(eventName, eventHandler);
    }
};
