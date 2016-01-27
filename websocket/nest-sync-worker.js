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
    console.log('Nest firebase client starts [%s]', this.accessToken);

    //Set up Firebase client
    this.firebase.authWithCustomToken(this.accessToken, function (error, authData) {
        if (error) {
            if (error.code === 'UNAUTHORIZED') {
                console.error('Current token [%s] is not valid: ', that.accessToken, error);
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
        console.log('Nest firebase client [%s] disconnected', this.accessToken);
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
            callback(new Error('No data loaded from the root of the Firebase connection'));
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

    console.log('Listen to new/removed children [topic = %s, client = %s]', path, this.accessToken);

    that._saveChild(ref);
    ref.on('child_added', function (snapshot) {
        var childAdded = snapshot.val();
        if (!childAdded) {
            console.log('No data on "child_added" event.');
            return;
        }

        var newPath = path + '/' + childAdded[idProp];
        that._subscribeEntity(newPath, updateEntity);
    });

    that._saveChild(ref);
    ref.on('child_removed', function (snapshot) {
        var childRemoved = snapshot.val();
        if (!childRemoved) {
            console.log('No data on "child_removed" event.');
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
            console.log('No data on "value" event');
            return;
        }

        that.lastUpdate[updateEntity] = nestStateUpdate;
    });
}

NestSyncWorker.prototype.stop = function (callback) {
    console.log('Stop nest firebase client [%s]', this.accessToken);

    _.values(this.childs).forEach(function (ref) {
        console.log(ref.toString());
        ref.off();
    });
    this.context.interrupt();
    this.firebase.offAuth(this._onAuthComplete, this);
    this.firebase.unauth();
    this.firebase = null;
    async.nextTick(callback);
}

// === exports ============================================================= //

module.exports = NestSyncWorker;
