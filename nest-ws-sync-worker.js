// === imports ============================================================= //

var Firebase = require('firebase');
var EventEmitter = require('events').EventEmitter;
var async = require('async');
var _ = require('lodash');
var util = require('util');

// === class =============================================================== //

function NestSyncWorker(accessToken) {
    if (!(this instanceof NestSyncWorker)) {
        return new NestSyncWorker(accessToken);
    }

    EventEmitter.call(this);

    this.accessToken = accessToken;
    this.lastUpdate = {};

    this.firebase = null;
    this.context = null;
    this.childs = {};
}

NestSyncWorker.prototype = Object.create(EventEmitter.prototype);

NestSyncWorker.prototype.start = function (callback) {
    if (this.firebase) {
        callback(new Error('Already started'));
        return;
    }

    var that = this;

    this.context = new Firebase.Context();
    this.firebase = new Firebase('wss://developer-api.nest.com', this.context);
    console.log('[ WS ] Nest firebase client starts [accessToken = %s]', this._token());

    //Set up Firebase client
    this.firebase.authWithCustomToken(this.accessToken, function (error, authData) {
        if (error) {
            if (error.code === 'UNAUTHORIZED') {
                console.error("[ WS ] Client wasn't authorized [accessToken = %s]: ", that._token(), error);
            }
            callback(error);
        } else {
            // add disconnect event
            that.firebase.onAuth(that._onAuthComplete, that);

            // subscribe
            that._bootstrapSubscriptions(callback);
        }
    });
}

NestSyncWorker.prototype._onAuthComplete = function (onAuthData) {
    if (!onAuthData) {
        console.log('[ WS ] Nest firebase client [accessToken = %s] disconnected', this._token());
        this.emit('stop');
    }
}

NestSyncWorker.prototype._saveChild = function(ref) {
    this.childs[ref.toString()] = ref;
}

NestSyncWorker.prototype._bootstrapSubscriptions = function (callback) {
    var that = this;

    this.firebase.once('value', function (snapshot) {
        var dataModel = snapshot.val();
        if (!dataModel) {
            callback(new Error('[ WS ] No data loaded from the root of the Firebase connection'));
        } else {
            that._subscribeEntities('/structures', 'structure_id', 'structure');
            that._subscribeEntities('/devices/thermostats', 'device_id', 'thermostat');
            that._subscribeEntities('/devices/smoke_co_alarms', 'device_id', 'smoke_co_alarm');
            callback();
        }
    });
}

NestSyncWorker.prototype._subscribeEntities = function (path, idProp, updateEntity) {
    var ref = this.firebase.child(path);
    var that = this;

    console.log('[ WS ] Listen to new/removed children [topic = %s, accessToken = %s]', path, this._token());

    that._saveChild(ref);
    ref.on('child_added', function (snapshot) {
        var childAdded = snapshot.val();
        if (!childAdded) {
            console.log('[ WS ] No data on "child_added" event.');
            return;
        }

        var newPath = path + '/' + childAdded[idProp];
        that._subscribeEntity(newPath, updateEntity);
    });

    that._saveChild(ref);
    ref.on('child_removed', function (snapshot) {
        var childRemoved = snapshot.val();
        if (!childRemoved) {
            console.log('[ WS ] No data on "child_removed" event.');
            return;
        }

        console.log("child_removed");
    });

}

NestSyncWorker.prototype._subscribeEntity = function (path, updateEntity) {
    var that = this;
    var ref = this.firebase.child(path);

    that._saveChild(ref);
    ref.on('value', function (snapshot) {
        var nestStateUpdate = snapshot.val();
        if (!nestStateUpdate) {
            console.log('[ WS ] No data on "value" event');
            return;
        }

        that.lastUpdate[updateEntity] = nestStateUpdate;
    });
}

NestSyncWorker.prototype.stop = function (callback) {
    console.log('[ WS ] Stop nest firebase client [accessToken = %s]', this._token());

    _.values(this.childs).forEach(function (ref) {
        ref.off();
    });
    this.context.interrupt();
    this.firebase.offAuth(this._onAuthComplete, this);
    this.firebase.unauth();
    this.firebase = null;
    async.nextTick(callback);
}

NestSyncWorker.prototype._token = function() {
    return util.format('%s...%s', this.accessToken.substr(0, 5), this.accessToken.substr(this.accessToken.length - 5, 5));
}

// === exports ============================================================= //

module.exports.NestWSSyncWorker = NestSyncWorker;
