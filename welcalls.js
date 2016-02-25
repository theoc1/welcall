'use strict';

let ariClient = require('ari-client'),
    path = require('path'),
    io = require('socket.io'),
    co = require('co'),
    loggerFactory = require('./components/LoggerFactory'),
    WelcallsSession = require('./components/WelcallSession');

module.exports = class WelcallsApp {

    constructor() {
        this.config = require('./config');
        this.logger = loggerFactory(path.join(path.dirname(require.main.filename), this.config.welcalls.logfile));
        this.configureProcess();
        this.configureSockets();
        this.sessions = new Map(); // incomingChannel => WelcallsSession
        this.sessionsQueue = [];   // array of sessions placed to queue
        co(this.ariConnect.bind(this))
            .catch( err => this.logger.error(err) );
    }

    *ariConnect() {
        let ari = yield ariClient.connect(this.config.ari.host, this.config.ari.user, this.config.ari.pass);
        this.logger.debug('ARI connected');
        this.ari = ari;
        this.ariInit();
    }

    configureProcess() {
        process.stdin.resume();
        process.on('unhandledRejection', (reason, p) => this.logger.error('Unhandled Rejection', p, reason));
        process.on('uncaughtException', err => this.logger.error('Caught exception', err));
    }

    ariInit() {

        this.ari.on('StasisStart', (event, channel) => {
            if (!(event.args && event.args[0] == 'managerCall')) this.handleIncomingChannel(event, channel);
        });

        this.ari.on('ChannelUserevent',
            (event) => {
                if (event.eventname === 'DialOut') this.handleDialoutEvent(event);
            }
        );

        this.ari.start(this.config.welcalls.stasis);

        this.ari.applications.subscribe({
                applicationName: this.config.welcalls.stasis,
                eventSource: 'endpoint:SIP'
            })
            .catch( error => this.logger.error(`Can't subscribe to eventSource. Error: ${error.message}`) );
    }

    handleIncomingChannel(event, channel) {
        this.logger.info(`Incoming call`, {
            id: channel.id,
            caller: { name: event.channel.caller.name, num: event.channel.caller.number }
        });

        this.createSession(channel, event);

    }

    handleDialoutEvent(event) {
        this.logger.info('DialOut: %s => %s', event.userevent.phone, event.userevent.to);
        this.sendToSockets('sessions', 'dial-out', {
            id: event.channel.id,
            name: event.channel.name,
            state: event.userevent.state,
            phone: event.userevent.phone,
            to: event.userevent.to
        });
    }

    createSession(channel, event) {
        let session = new WelcallsSession(this, channel, event);
        this.sessions.set(channel, session);
        this.notifySockets('session-new', session);
        session.on('StartSession', (id) => this.logger.info(`SESSION START. Id: ${id}`));
        session.on('ChannelConnected', () => this.notifySockets('session-talking', session));
        session.on('ChannelPlacedToQueue', () => this.sessionsQueue.push(session));
        session.on('EndOfSession', (channelWasAnswered, cause) => {
            this.logger.info(`END OF SESSION. ID: ${session.id}. Cause: ${cause}`);
            if (this.sessionsQueue.indexOf(session) != -1) { // if ended session was in a queue
                this.sessionsQueue.slice(this.sessionsQueue.indexOf(session), 1);
            }
            if (this.sessionsQueue.length > 0 && channelWasAnswered) {
                this.logger.info(`Pop from queue caller: ${this.sessionsQueue[0].channels.incoming.caller.number}`);
                co(this.sessionsQueue[0].popFromQueue.bind(this.sessionsQueue[0]))
                    .catch(error => this.logger.error(`Error poping session-${this.sessionsQueue[0].id} ${error}`));
                this.sessionsQueue.shift();
            }
        });
        co(session.initiate.bind(session))
            .then(() => this.deleteSession(session.channels.incoming))
            .catch(error => {
                this.logger.error(`Error init session: ${error.stack}`);
                this.deleteSession(channel);
            });
    }

    deleteSession(channel) {
        this.notifySockets('session-end', this.sessions.get(channel));
        this.sessions.delete(channel);
    }

    // Methods for work with Sockets

    getSessionInfo(session) {
        return {
            id: session.id,
            manager: session.officeInfo ? session.officeInfo.manager : null,
            state: session.state,
            'talk-start': session.talkStarted,
            dialed: session.dialer ? session.dialer.number : null,
            duration: session.talkStarted ? Date.now() - session.talkStarted : null,
            channels: {
                'in': this.getChannelInfo(session.channels.incoming),
                out:  this.getChannelInfo(session.channels.outgoing)
            }
        }
    }

    getChannelInfo(channel) {
        if (!channel) return null;
        return { id: channel.id, name: channel.name, caller: channel.caller }
    }

    configureSockets() {
        this.socketio = io(this.config.welcalls.socket.port);
        this.openSockets = new Map();
        this.socketio.on('connection', socket => this.registerSocket(socket));
    }

    registerSocket(socket) {
        this.openSockets.set(socket.id, { socket });
        socket.on('disconnect', () => this.openSockets.delete(socket.id));
        socket.emit('active-sessions', Array.from(this.sessions.values()).map( data => this.getSessionInfo(data) ));
        socket.join('sessions');
    }

    sendToSockets(room, event, data) {
        this.logger.info('Socket [%s]: %s', room, event, data);
        this.socketio.to(room).emit(event, data);
    }

    notifySockets(event, session) {
        let data = this.getSessionInfo(session);
        this.sendToSockets('sessions', event, data);
    }

};

