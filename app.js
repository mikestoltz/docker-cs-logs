'use strict';

const _ = require('lodash');
const express = require('express');
const fs = require('fs');
const helmet = require('helmet');
const stream = require('stream');
const Readable = stream.Readable;

const PORT = process.env.PORT || 3000;
let CS_PROC_OPTS = process.env.CS_PROC_OPTS;
let cs_log_path = null;

if (CS_PROC_OPTS) {
    try {
        CS_PROC_OPTS = JSON.parse(CS_PROC_OPTS);
        cs_log_path = CS_PROC_OPTS['base-log-dir'];
    } catch (err) {
        console.warn('Could not parse process.env.CS_PROC_OPTS');
    }
}

cs_log_path = cs_log_path || process.env.CSHIP_LOG_PATH;

const app = new express();

app.use(helmet());

// routes
app.get('/logs/applications/:application/containers/:container', getContainerLogs);
app.get('/logs/hosts/:host', getContainershipHostLogs);

app.listen(PORT, () => {
    console.log(`Containership-Logs listening on port: ${PORT}`);
});

function getContainershipHostLogs(req, res, next) {
    // TODO - NT: support stderr/stdout: currently, host logs are combined into single containership.log file

    const hostLogPath = `${cs_log_path}/containership.log`;
    const responseStream = fs.existsSync(hostLogPath) ? new WatchStream(hostLogPath) : null;

    if (null === responseStream) {
        res.status(404);
        res.send(`No logs were found for host[${req.params.host}] at path[${hostLogPath}]`);
        return next();
    }

    return responseStream.pipe(res);
}

function getContainerLogs(req, res, next) {
    const application = req.params.application;
    const container = req.params.container;
    const streamType = req.query.type || 'stdout';

    if (!application || !container) {
        res.status(400);
        return next();
    }

    const containerLogPath = `${cs_log_path}/applications/${application}/${container}`;
    const stdoutPath = `${containerLogPath}/stdout`;
    const stderrPath = `${containerLogPath}/stderr`;

    let responseStream;

    switch (streamType) {
        case 'stdout':
            responseStream = fs.existsSync(stdoutPath) ? new WatchStream(stdoutPath) : null;
            break;
        case 'stderr':
            responseStream = fs.existsSync(stderrPath) ? new WatchStream(stderrPath) : null;
            break;
        default:
            res.status(400);
            res.send('If providing the query parameter `type`, it must take either `stdout` or `stderr` as its value');
            return next();
    }

    if (null === responseStream) {
        res.status(404);
        res.send(`No ${streamType} logs were found for container[${container}] in application[${application}]`);
        return next();
    }

    return responseStream.pipe(res);
}

class WatchStream extends Readable {
    constructor(options, path) {
        if (!path) {
            path = options;
            options = null;
        }

        options = options || {};

        super(_.pick(options, ['highWaterMark', 'encoding', 'objectMode']));

        this.options = options;
        this.options._path = path;

        if (!fs.existsSync(this.options._path)) {
            throw new Error(`File does not exist: ${path}`);
        }

        this.options._stream = null;

        // if we should push more data through stream
        this.options._shouldRead = false;

        // if the underlying stream source has updates to push
        this.options._hasSourceUpdates = false;

        // position of underlying source to read
        this.options._sourceOffset = 0;
    }

    _read(size) {
        this.options._shouldRead = true;

        if (!this.options._watcher) {
            this.options._watcher = fs.watch(this.options._path, { persistent: true }, (event, data) => {
                switch (event) {
                    case 'error': {
                        console.error('Error: ' + data);
                        console.error('Closing stream');

                        if (null != this.options._watcher) {
                            this.options._watcher.close();
                        }

                        return this.push(null);
                    }
                    case 'change': {
                        this.options._hasSourceUpdates = true;

                        // close out existing stream and create new one
                        if (null !== this.options._stream) {
                            this.options._stream.close();
                            this.options._stream = null;
                        }

                        if (!fs.existsSync(this.options._path)) {
                            console.error('File was deleted or moved');

                            if (null != this.options._watcher) {
                                this.options._watcher.close();
                            }

                            return this.push(null);
                        }

                        //If the offset exceeds the size of the file, it's been truncated, and we should read 
                        //from the start again.
                        const stats = fs.statSync(this.options._path);
                        const maxOffset = stats.size;
                        if (this.options._sourceOffset >= maxOffset) {
                            this.options._sourceOffset = 0;
                        }

                        this.options._stream = fs.createReadStream(this.options._path, {
                            start: this.options._sourceOffset
                        });

                        this.options._stream.on('readable', () => {
                            if (!this.options._shouldRead) {
                                return;
                            }

                            let chunk;

                            while (null !== (chunk = this.options._stream.read())) {
                                this.options._sourceOffset += chunk.length;

                                if (!this.push(chunk)) {
                                    this.options._shouldRead = false;
                                    this.options._stream.close();

                                    break;
                                }
                            }
                        });

                        this.options._stream.on('end', () => {
                            this.options._stream = null;
                        });

                        break;
                    }
                    default: {
                        console.error('Unknown event type, closing stream');

                        if (null != this.options._watcher) {
                            this.options._watcher.close();
                        }

                        return this.push(null);
                    }
                }
            });

            this.options._watcher.emit('change', 'change');
            return;
        }

        if (null !== this.options._stream) {
            this.options._stream.emit('readable');
        }
    }
}
