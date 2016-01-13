var fs = require('fs');
var NestSyncWorker = require('./nest-sync-worker');
var Firebase = require('firebase');
var async = require('async');
var _ = require('lodash');
var nconf = require('nconf');

nconf.argv({
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

var workers = [];
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
        async.each(config.userTokens, function (token, callback) {
            var worker = new NestSyncWorker(token);
            worker.on('stop', function () {
                worker.stop(function () {
                    worker.start(function () {
                    });
                });
            });

            worker.start(function () {
                workers.push(worker);
                callback();
            });
        }, function (err) {
            cb(err);
        });
    }],
    scheduleUpdate: ['startWorkers', function (cb, results) {
        var testInterval = nconf.get('testInterval');
        console.log('Connecting to firebase and scheduling the updates every %d seconds', testInterval);

        var config = results.readConfig;

        context = new Firebase.Context();
        firebaseRef = new Firebase(config.firebaseUrl, context);

        console.log('\n------ START TEST ------');
        interval = setInterval(function () {
            updateAndCheck(config.adminToken);
        }, testInterval * 1000);

        cb();
    }]
}, function (err) {
    if (err) {
        console.error('An error occurred during test set up: ', err);
        shutdown();
    }
});


function updateAndCheck(token) {
    async.auto({
        update: function (cb) {
            updateThermostat(token, cb);
        },
        receive: ['update', function (cb, results) {
            var thermostat = results.update;
            async.map(workers, function (worker, callback) {
                receiveUpdate(worker, thermostat, 'target_temperature_f', function(err, updated) {
                    callback(null, updated ? null : worker);
                });
            }, function (err, results) {
                if (err) {
                    throw err;
                }
                cb (null, results);
            })
        }],
        check: ['receive', function(cb, results) {
            checkReceived(results.receive);
        }]
    }, function (err) {
        if (err) {
            console.error(err);
        }
    });
}

function checkReceived(results) {
    var lost = _.without(results, null);
    if (lost && lost.length > 0) {
        console.error('TEST FAILED [total - %d, received - %d, lost - %d]', workers.length, workers.length - lost.length, lost.length);
        console.error('Lost updates for nest firebase clients: ', lost.map(function (l) {
            return l.accessToken
        }));
    } else {
        console.log('TEST PASSED [all updates - %d, received - %d, lost - %d]', workers.length, workers.length - lost.length, lost.length);
    }
}

function updateThermostat(token, cb) {
    firebaseRef.authWithCustomToken(token, function (err, authData) {
        if (err || !authData) {
            cb(new Error('Failed to auth to Nest'));
        } else {
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
    });
}

function receiveUpdate(worker, update, property, callback) {
    var retryOpts = {times: nconf.get('checkTimes'), interval: nconf.get('checkInterval')};
    async.retry(retryOpts, function (cb) {
        if (worker.lastUpdate['thermostat'] && _.isEqual(worker.lastUpdate['thermostat'][property], update[property])) {
            cb(null);
        } else {
            cb(new Error('Update not received'));
        }
    }, function (err) {
        return callback(null, !err);
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

    if (!_.isEmpty(workers)) {
        workers.forEach(function (worker) {
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