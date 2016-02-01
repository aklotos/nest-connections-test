// === imports ============================================================= //

var Firebase = require('firebase');
var EventEmitter = require('events').EventEmitter;
var async = require('async');
var _ = require('lodash');
var util = require('util');
var EventSource = require('eventsource');

// === class =============================================================== //

function NestSyncWorker(accessToken) {
    if (!(this instanceof NestSyncWorker)) {
        return new NestSyncWorker(accessToken);
    }

    EventEmitter.call(this);

    this.accessToken = accessToken;
    this.lastUpdate = {};

    this.firebaseES = null;
    this.children = {
        structures: [],
        thermostats: [],
        smokeAlarms: []
    };
}

NestSyncWorker.prototype = Object.create(EventEmitter.prototype);

NestSyncWorker.prototype.start = function (callback) {
    if (this.firebaseES) {
        callback(new Error('[REST] Already started [accessToken = %s]', this._token()));
        return;
    }

    var that = this;


    var url = this._getUrl('/');
    this.firebaseES = new EventSource(url);

    this.firebaseES.onopen = function () {
        console.log('[REST] Opened connection [accessToken = %s]', that._token());
    };

    this.firebaseES.onerror = function(e) {
        if (e.status === 401 || e.status === 403) {
            console.log("[REST] Client wasn't authorized [accessToken = %s]", that._token());
            that.emit('stop');
        } else {
            console.error('[REST] Error receiving event [accessToken = %s]: ', that._token(), e);
            callback();
        }
    };

    function processPut(e) {
        if (!e.data) {
            console.error('[REST] No data loaded from the root of the Firebase connection');
        } else {
            var data = JSON.parse(e.data);
            that._processDevices(data.data['structures'], 'structures', '/structures/', 'structure');
            if (data.data['devices']) {
                that._processDevices(data.data['devices']['thermostats'], 'thermostats', '/devices/thermostats/', 'thermostat');
                that._processDevices(data.data['devices']['smoke_co_alarms'], 'smokeAlarms', '/devices/smoke_co_alarms/', 'smokeAlarm');
            }
        }
    }

    this.firebaseES.addEventListener('put', function (e) {
        console.log('[REST] Listen to new/removed children [accessToken = %s]', that._token());

        that.firebaseES.removeAllListeners('put');
        processPut(e);
        that.firebaseES.addEventListener('put', processPut);
        callback();
    });

    this.firebaseES.addEventListener('patch', function (e) {
        console.log("[REST] message patch: ", e);
    });
}

NestSyncWorker.prototype._processDevices = function(devices, child, relativePath, updateProp) {
    var that = this;
    if (devices) {
        var putKeys = Object.keys(devices);
        var childrenKeys = _.map(this.children[child], function (s) { return s.id });

        var keysToRemove = _.difference(childrenKeys, putKeys);
        if (!_.isEmpty(keysToRemove)) {
            this.children[child].forEach(function(childDevice, index) {
                if (keysToRemove.indexOf(childDevice.id) >= 0) {
                    childDevice.eventSource.close();
                    that.children[child].splice(index, 1);
                }
            });
        }

        var keysToAdd = _.difference(putKeys, childrenKeys);
        if (!_.isEmpty(keysToAdd)) {
            keysToAdd.forEach(function (newId) {
                var eventSource = new EventSource(that._getUrl(relativePath + newId));
                eventSource.addEventListener('put', function(e) {
                    if (e.data) {
                        var data = JSON.parse(e.data);
                        that.lastUpdate[updateProp] = data.data;
                    }
                });
                eventSource.onerror = function (e) {
                    if (e.status === 401 || e.status === 403) {
                        console.log("[REST] Client wasn't authorized [accessToken = %s]", that._token());
                    } else {
                        console.error('[REST] Error during request [accessToken = %s]: ', that._token(), e);
                    }
                }
                that.children.structures.push({id: newId, eventSource: eventSource});
            });
        }
    }
}

NestSyncWorker.prototype._getUrl = function(relativeUrl) {
    return util.format("https://developer-api.nest.com%s?auth=%s", relativeUrl, this.accessToken);
}

NestSyncWorker.prototype.stop = function (callback) {
    console.log('[REST] Stop nest firebase client [accessToken = %s]', this._token());

    _.values(this.children).forEach(function (devices) {
        _.values(devices).forEach(function (device) {
           device.eventSource.close();
        });
    });
    this.firebaseES.close();
    async.nextTick(callback);
}

NestSyncWorker.prototype._token = function() {
    return util.format('%s...%s', this.accessToken.substr(0, 5), this.accessToken.substr(this.accessToken.length - 5, 5));
}

// === exports ============================================================= //

module.exports.NestRSSyncWorker = NestSyncWorker;
