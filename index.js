var fs = require('fs');
var NestRSSyncWorker = require('./nest-rs-sync-worker').NestRSSyncWorker;
var NestWSSyncWorker = require('./nest-ws-sync-worker').NestWSSyncWorker;
var Firebase = require('firebase');
var async = require('async');
var _ = require('lodash');
var nconf = require('nconf');

nconf.argv({
    "mode": {
        default: "ws"
    },
    "testInterval": {
        default: 60
    },
    "checkInterval": {
        default: 500
    },
    "checkTimes": {
        default: 60
    }
});

if (!nconf.get('config')) {
    console.error("Argument 'config' must be provided");
    return;
}

var rsWorkers = [];
var wsWorkers = [];
var firebaseRef, context, interval;

async.auto({
    readConfig: function (cb) {
        console.log('Reading config file');

        var config = JSON.parse(fs.readFileSync(nconf.get('config'), 'utf8'));
        cb(null, config)
    },
    startWorkers: ['readConfig', function (cb, results) {
        console.log('Starting nest sync workers');

        var config = results.readConfig;
        var mode = nconf.get('mode');

        async.parallel([
            function (callback) {
                if (mode === 'rs') {
                    callback();
                } else {
                    async.each(config.userTokens, function (token, callback) {
                        startWorker(NestWSSyncWorker, token, wsWorkers, callback);
                    }, function (err) {
                        callback(err);
                    });
                }
            },
            function (callback) {
                if (mode === 'ws') {
                    callback()
                } else {
                    async.each(config.userTokens, function (token, callback) {
                        startWorker(NestRSSyncWorker, token, rsWorkers, callback);
                    }, function (err) {
                        callback(err);
                    });
                }
            }
        ], function (err) {
            cb(err);
        });
    }],
    scheduleUpdate: ['startWorkers', function (cb, results) {
        var testInterval = nconf.get('testInterval');
        console.log('Connecting to firebase and scheduling the updates every %d seconds', testInterval);

        var config = results.readConfig;

        context = new Firebase.Context();
        firebaseRef = new Firebase("wss://developer-api.nest.com", context);

        console.log('\n------ START TEST ------');
        interval = setInterval(function () {
            updateAndCheck(config.masterToken);
        }, testInterval * 1000);

        cb();
    }]
}, function (err) {
    if (err) {
        console.error('An error occurred during test set up: ', err);
        shutdown();
    }
});

function startWorker(Worker, token, workers, callback) {
    var worker = new Worker(token);
    worker.on('stop', function () {
        _.remove(workers, function (w) {
            return w.accessToken === token;
        });
        worker.stop(function () {
            worker.start(function (err) {
                if (!err) {
                    workers.push(worker);
                }
            });
        });
    });

    worker.start(function (err) {
        if (!err) {
            workers.push(worker);
        }
        callback(err);
    });
}

function updateAndCheck(token) {
    async.auto({
        update: function (cb) {
            updateThermostat(token, cb);
        },
        receiveWS: ['update', function (cb, results) {
            if (nconf.get('mode') === 'rs') {
                return cb();
            }

            var thermostat = results.update;
            async.map(wsWorkers, function (worker, callback) {
                receiveUpdate(worker, thermostat, 'target_temperature_f', function(err, updated, time) {
                    callback(null, {worker: updated ? null : worker, time: time});
                });
            }, function (err, results) {
                if (err) {
                    throw err;
                }
                cb(null, results);
            });
        }],
        receiveRS: ['update', function(cb, results) {
            if (nconf.get('mode') === 'ws') {
                return cb();
            }

            var thermostat = results.update;
            async.map(rsWorkers, function (worker, callback) {
                receiveUpdate(worker, thermostat, 'target_temperature_f', function(err, updated, time) {
                    callback(null, {worker: updated ? null : worker, time: time});
                });
            }, function (err, results) {
                if (err) {
                    throw err;
                }
                cb(null, results);
            });
        }],
        checkWS: ['receiveWS', function(cb, results) {
            if (nconf.get('mode') === 'rs') {
                return cb();
            }

            checkReceived(results.receiveWS, wsWorkers.length, '[ WS ]');
            cb();
        }],
        checkRS: ['receiveRS', function(cb, results) {
            if (nconf.get('mode') === 'ws') {
                return cb();
            }

            checkReceived(results.receiveRS, rsWorkers.length, '[REST]');
            cb();
        }]
    }, function (err) {
        if (err) {
            console.error(err);
        }
    });
}

function checkReceived(results, total, prefix) {
    var lost = _.filter(results, r => r.worker);
    var elapsedTime = _.max(_.map(results, w => w.time));
    if (lost && lost.length > 0) {
        console.error('%s TEST FAILED [total - %d, received - %d, lost - %d]', prefix, total, total - lost.length, lost.length);
        console.error('%s Lost updates for nest firebase clients: ', prefix, lost.map(function (l) {
            return l.worker.accessToken;
        }));
    } else {
        console.log('%s TEST PASSED [all updates - %d, received - %d, lost - %d, time - %s ms]', prefix, total, total - lost.length, lost.length, elapsedTime);
    }
}

function updateThermostat(token, cb) {
    var auth = firebaseRef.getAuth();
    if (auth) {
        updateOnceValue(cb);
    } else {
        firebaseRef.authWithCustomToken(token, function (err, authData) {
            if (err || !authData) {
                cb(new Error('Failed to auth to Nest'));
            } else {
                console.log('Authenticated master client [accessToken = %s]', token);
                updateOnceValue(cb);
            }
        });
    }
}

function updateOnceValue(cb) {
    firebaseRef.once('value', function (snapshot) {
        var metadata = snapshot.val();
        if (!metadata) {
            cb(new Error('No data for testing.'));
        } else {
            var thermostats = _.get(metadata, 'devices.thermostats');
            if (_.isEmpty(thermostats)) {
                cb(new Error('No thermostat to update'));
                return;
            }

            var tKey = _.sample(_.keys(thermostats));
            var tTempF = thermostats[tKey]['target_temperature_f'];
            if (++tTempF == 90) {
                tTempF = 50;
            }
            thermostats[tKey]['target_temperature_f'] = tTempF;
            var updateRef = '/devices/thermostats/' + tKey;

            console.log('%s: Sending update [device = %s, target_temperature_f = %d]', new Date().toISOString(), tKey, tTempF);

            firebaseRef.child(updateRef).set({'target_temperature_f': tTempF});
            cb(null, thermostats[tKey]);
        }
    });
}

function receiveUpdate(worker, update, property, callback) {
    var retryOpts = {times: nconf.get('checkTimes'), interval: nconf.get('checkInterval')};
    var start = process.hrtime();
    async.retry(retryOpts, function (cb) {
        if (worker.lastUpdate['thermostat'] && _.isEqual(worker.lastUpdate['thermostat'][property], update[property])) {
            cb(null);
        } else {
            cb(new Error('Update not received'));
        }
    }, function (err) {
        var elapsedMillis = (process.hrtime(start)[0] * 1000 + process.hrtime(start)[1] / 1000000).toFixed(0);
        return callback(null, !err, elapsedMillis);
    });
}

process.on('uncaughtException', function (err) {
    console.error("Uncaught error: ", err);
    if (err.stack) {
        console.error(err.stack);
    }
    shutdown();
});

process.on('SIGINT', function () {
    console.log('Process got SIGINT. Stop test');
    shutdown();
});

process.on('SIGTERM', function () {
    console.log('Process got SIGTERM. Stop test');
    shutdown();
});

function shutdown() {
    console.log('Shutting down test');

    clearInterval(interval);

    if (!_.isEmpty(wsWorkers)) {
        wsWorkers.forEach(function (worker) {
            worker.removeAllListeners('stop');
            worker.stop(function () {
            });
        })
    }

    if (!_.isEmpty(rsWorkers)) {
        rsWorkers.forEach(function (worker) {
            worker.removeAllListeners('stop');
            worker.stop(function () {
            });
        })
    }

    if (context) {
        context.interrupt();
    }
    if (firebaseRef) {
        firebaseRef.unauth();
    }
    process.exit();
}