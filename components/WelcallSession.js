'use strict';
let events = require('events'),
    request = require('request-promise'),
    co = require('co'),
    path = require('path'),
    t = require('tcomb-validation');

module.exports = class WelcallSession extends events.EventEmitter {
    constructor(app, channel, event) {
        super();
        this.id = require('uuid').v4();
        //this.app = app;
        this.logger= app.logger;
        this.ari = app.ari;
        this.managersEndpoints = app.config.welcalls.phones.production;
        this.getResponsibleUrl = app.config.welcalls.url.clientinfo;
        this.localPhones = app.config.welcalls.phones.local;
        this.applicationName = app.config.welcalls.stasis;
        this.event = event;
        this.extension = ''; // listen dtmf for extension
        this.channels = {
            incoming: channel,
            outgoing: null
        };
        this.modelsDomain = require('./../modelsDomain');
        this.sessionEnded = false;

    }

    initiate() {
        this.emit('StartSession', this.id);
        this.channels.incoming.on('StasisEnd', () => {
            if (!this.bridge) {
                this.endSession('Incoming call hanged up before manager answer.');
            }
        });

        this.isCallFromLocal = this.localPhones.indexOf(this.channels.incoming.caller.number) !== -1;

        co(this.routeSession.bind(this));
    }

    *getOnlineManagers() {
        let sipEndpoints = yield this.ari.endpoints.listByTech({tech: 'SIP'});
        let sipOnlineEndpoints = yield sipEndpoints
            .filter(endpoint =>
                endpoint.state == 'online' &&                              // endpoind registered
                this.managersEndpoints.indexOf(endpoint.resource) != -1    // endpoint is manager
            );
        return sipOnlineEndpoints;
    }

    *getResponsibleManager(callerId) {
        if (!this.sessionEnded) {
            if (typeof callerId !== 'string' || callerId === '') throw new TypeError('CallerId must be not empty string');
            let requestConfig = {qs: {phone: callerId}, json: true, uri: this.getResponsibleUrl};
            let data = yield request(requestConfig);
            if (!data) return false;           // if get false
            let validator = t.validate(data, this.modelsDomain.OfficeInfo);
            if (validator.isValid()) return data;
            else throw new Error(validator.errors);
        }
    }

    *routeSession() {

        if (!this.sessionEnded) {
            try {
                this.responsibleManager = yield this.getResponsibleManager(this.channels.incoming.caller.number);
            } catch (error) {
                this.logger.warn(`Error on get responsible manager. ${error}. CallerID: ${this.channels.incoming.caller.number}`);
                this.responsibleManager = false;
            }

            if (this.isCallFromLocal) {
                yield this.proceedToDial();
            } else {
                yield this.placeDtmfListeners();
                yield this.playAudioFile('welcalls/ivr-welcome');
                yield this.playAudioFile('welcalls/ivr-sip');
                yield this.removeDtmfListeners();
                yield this.proceedToDial();
            }
        }
    }

    *proceedToDial() {
        if (!this.sessionEnded) {
            this.logger.info(`Processing to dial`);

            this.logger.info(`\n Responsible manager: ${JSON.stringify(this.responsibleManager)}. \n isCallFromLocal: ${this.isCallFromLocal}`);

            this.channels.incoming.ring();
            if (this.responsibleManager) {
                //try {
                //    yield this.dialToOne(this.responsibleManager.phones[0].substr(4), 15); // Remove 'SIP/'
                //} catch (e) {
                //    this.logger.info(e);
                //    yield this.dialToAll();
                //}
                let tryToCallResponsible = yield this.dialToOne(this.responsibleManager.phones[0].substr(4), 15); // Remove 'SIP/'
                if (tryToCallResponsible) {             // only if try failed
                    this.logger.info(tryToCallResponsible);
                    yield this.dialToAll();
                }

            } else {
                yield this.dialToAll();
            }
        }
    }

    *placeDtmfListeners() {
        function dtmfReceived(event) {
            this.extension += event.digit;
            if (/^2\d\d$/.test(this.extension)) {
                this.responsibleManager = { phones: ['SIP/' + this.extension] };
                this.logger.info(`Changed responsible manager by DTMF to: ${this.extension}`);
                this.emit('CancelPlayback');
            }
        }

        if (!this.sessionEnded) {
            try {
                this.channels.incoming.on('ChannelDtmfReceived', dtmfReceived.bind(this));
                this.logger.info(`Start listening DTMF`);
            } catch (e) {
                this.logger.error(`Error placing DTMF Listener: ${e}`);
            }
        }

    }

    *removeDtmfListeners() {
        if (!this.sessionEnded) {
            try {
                this.channels.incoming.removeAllListeners('ChannelDtmfReceived');
                this.logger.info(`Stop listening DTMF`);
            } catch (e) {
                this.logger.error(`Error remove DTMF Listener: ${e}`);
            }
        }
    }

    *playAudioFile(file) {
        if (!this.sessionEnded) {
            this.logger.info(`Playing file: ${file}`);
            let playback = this.ari.Playback();
            return new Promise((resolve) => {
                this.channels.incoming.play({media: 'sound:' + file}, playback)
                    .catch(error => {
                        this.logger.error(`Error whith playing file ${file}: ${error}`);
                        resolve();
                    });
                playback.on('PlaybackFinished', () => {
                    if (playback) {
                        this.logger.info(`Playing file ${file} finished`);
                        playback = undefined;
                        resolve();
                    }
                });
                this.on('CancelPlayback', () => {
                    if (playback) {
                        this.logger.info(`Cancel playing file: ${file}`);
                        playback.stop();
                        resolve();
                    }
                });
            });
        }
    }

    *placeToQueue() {
        if (!this.sessionEnded) {
            this.logger.info('Session placed to queue');
            this.emit('ChannelPlacedToQueue');
            yield this.channels.incoming.startMoh();
        }
    }

    *popFromQueue() {
        if (!this.sessionEnded) {
            this.logger.info('Try to pop from queue');
            yield new Promise(resolve => setTimeout(resolve, 5000)); // async sleep
            yield this.dialToAll();
        }
    }


    *dialToOne(managerNumber, timeout) {
        if (!this.sessionEnded) {
            try {
                let managerEndpoint = yield this.ari.endpoints.get({resource: managerNumber, tech: 'SIP'});
                let channel = this.ari.Channel();
                let newChannel = yield new Promise((resolve, reject) => {
                    if (managerEndpoint.channel_ids.length == 0 && managerEndpoint.state == 'online') {
                        this.logger.info(`Originating call to: ${managerNumber}`);
                        channel.originate({
                            endpoint: 'SIP/' + managerNumber,
                            app: this.applicationName,
                            appArgs: 'managerCall',
                            callerId: this.channels.incoming.caller.number,
                            timeout: timeout
                        }).catch(error => reject(`Error on originate: ${error}`));

                        channel.on('ChannelDestroyed', () => reject(`Manager hanged up a call`));
                        channel.on('StasisStart', () => {
                            this.logger.info(`Connected to manager: ${managerNumber}`);
                            this.emit('ManagerIsAnswered', channel);
                            resolve(channel);
                        });

                        this.on('ManagerIsAnswered', (answeredChannel) => {   // used by dialToAll
                            if (answeredChannel != channel) {
                                channel.hangup().catch(() => {}); // Nobody cares, channels answered.
                                reject(`Answered by another manager`);
                            }
                        });
                        this.on('CancelDial', () => {
                            channel.removeAllListeners('ChannelDestroyed');
                            channel.hangup().catch(() => {});
                        }); // Incoming is away. Hangup outgoing, suppress output.

                    } else {
                        reject(`Manager is busy or unavailable`);
                    }
                });
                this.channels.outgoing = newChannel;
                this.channels.outgoing.removeAllListeners('ChannelDestroyed');
                this.channels.incoming.ringStop();
                yield this.bridgeChannels(this.channels.incoming, this.channels.outgoing);
                this.startRecording();
                yield this.waitForEndOfTalking();
                this.endSession('Normal clearing');
            } catch (e) {
                return `Error to dial manager ${managerNumber}: ${e}`;
            }
        }
    }

    *dialToAll() {
        if (!this.sessionEnded) {
            try {
                this.onlineManagers = yield this.getOnlineManagers();
            } catch (error) {
                this.logger.error(`Error on get online managers: ${error}`);
                this.endSession(`Can\`t get managers`);
            }

            let availableOnlineManagers = this.onlineManagers
                .filter(endpoint => endpoint.channel_ids.length == 0);
            if (availableOnlineManagers.length != 0) {
                this.logger.info(`Available managers: ${availableOnlineManagers}`);
                let dialArray = availableOnlineManagers
                    .map((endpoint) => {
                        return this.dialToOne(endpoint.resource, 200);
                    });
                let resultArray = yield dialArray;
                if (!this.bridge) {
                    this.logger.info(resultArray);
                    this.endSession('Nobody answers');
                }
            } else if (this.onlineManagers.length != 0) {
                this.logger.info('All managers are busy. Placing channel to Queue');
                yield this.placeToQueue();
            } else {
                this.endSession('No managers online');
            }
        }
    }

    *bridgeChannels(incomingChannel, outgoingChannel){
        if (!this.sessionEnded) {
            try {
                let bridge = this.ari.Bridge();
                this.bridge = yield bridge.create();
                this.emit('CancelPlayback');
                yield this.bridge.addChannel({channel: incomingChannel.id});
                yield this.bridge.addChannel({channel: outgoingChannel.id});
                this.logger.info(`Channels connected to bridge id: ${this.bridge.id}`);
                this.emit('ChannelConnected');
            } catch (e) {
                this.logger.error(e);
            }
        }
    };

    *waitForEndOfTalking() {
        if (!this.sessionEnded) {
            yield new Promise(resolve => {
                this.channels.outgoing.on('StasisEnd', () => {
                    this.channels.incoming.removeAllListeners('StasisEnd');
                    resolve();
                });
                this.channels.incoming.on('StasisEnd', () => {
                    this.channels.outgoing.removeAllListeners('StasisEnd');
                    resolve();
                });
            })
        }
    }

    startRecording() {
        let recRoot = 'welcalls/';
        let date = new Date();
        let recPath = path.join(
            recRoot,
            date.getFullYear().toString(),
            (date.getMonth() + 1).toString(),
            date.getDate().toString()
        );
        let callerid = this.channels.incoming.caller.number ? this.channels.incoming.caller.number : 'unknown';
        this.logger.info(`Start recording to file: ${recPath}/${callerid}-${this.bridge.id}.wav`);
        this.bridge.record({
            format: 'wav',
            maxDurationSeconds: 600,
            name: `${recPath}/${callerid}-${this.bridge.id}`
        }).catch(error => this.logger.warn(`Error to record: ${error}`));
    }

    endSession(cause) {
        this.channels.incoming.removeAllListeners('StasisEnd'); // Handling hangups gonna fire recusrsion. Avoid that.
        this.channels.incoming.hangup()
            .then(() => this.logger.info('Incoming channel hanged up'))
            .catch(() => this.logger.info('Incoming channel already hanged'));
        if (this.channels.outgoing) {
            this.channels.outgoing.removeAllListeners();
            this.channels.outgoing.hangup()
                .then(() => this.logger.info('Outgoing channel hanged up'))
                .catch(() => this.logger.info('Outgoing channel already hanged'));
        }
        this.emit('CancelDial');
        if (this.bridge) this.bridge.destroy();
        this.sessionEnded = true;
        this.emit('EndOfSession', !!this.bridge, cause);
    }
};