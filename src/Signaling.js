import * as events from 'events';
import browser from 'bowser';

var RTCPeerConnection;
var RTCSessionDescription;
var configuration;

/*
 *  Copyright (c) 2014 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */

/* More information about these options at jshint.com/docs/options */

/* globals  adapter, trace */
/* exported setCodecParam, iceCandidateType,
   maybeSetOpusOptions, maybePreferAudioReceiveCodec,
   maybePreferAudioSendCodec, maybeSetAudioReceiveBitRate,
   maybeSetAudioSendBitRate, maybePreferVideoReceiveCodec,
   maybePreferVideoSendCodec, maybeSetVideoReceiveBitRate,
   maybeSetVideoSendBitRate, maybeSetVideoSendInitialBitRate,
   maybeRemoveVideoFec, mergeConstraints, removeCodecParam*/

'use strict';

function mergeConstraints(cons1, cons2) {
    if (!cons1 || !cons2) {
        return cons1 || cons2;
    }
    var merged = cons1;
    for (var key in cons2) {
        merged[key] = cons2[key];
    }
    return merged;
}

function iceCandidateType(candidateStr) {
    return candidateStr.split(' ')[7];
}

function maybeSetOpusOptions(sdp, params) {
    // Set Opus in Stereo, if stereo is true, unset it, if stereo is false, and
    // do nothing if otherwise.
    if (params.opusStereo === 'true') {
        sdp = setCodecParam(sdp, 'opus/48000', 'stereo', '1');
    } else if (params.opusStereo === 'false') {
        sdp = removeCodecParam(sdp, 'opus/48000', 'stereo');
    }

    // Set Opus FEC, if opusfec is true, unset it, if opusfec is false, and
    // do nothing if otherwise.
    if (params.opusFec === 'true') {
        sdp = setCodecParam(sdp, 'opus/48000', 'useinbandfec', '1');
    } else if (params.opusFec === 'false') {
        sdp = removeCodecParam(sdp, 'opus/48000', 'useinbandfec');
    }

    // Set Opus DTX, if opusdtx is true, unset it, if opusdtx is false, and
    // do nothing if otherwise.
    if (params.opusDtx === 'true') {
        sdp = setCodecParam(sdp, 'opus/48000', 'usedtx', '1');
    } else if (params.opusDtx === 'false') {
        sdp = removeCodecParam(sdp, 'opus/48000', 'usedtx');
    }

    // Set Opus maxplaybackrate, if requested.
    if (params.opusMaxPbr) {
        sdp = setCodecParam(
            sdp, 'opus/48000', 'maxplaybackrate', params.opusMaxPbr);
    }
    return sdp;
}

function maybeSetAudioSendBitRate(sdp, params) {
    if (!params.audioSendBitrate) {
        return sdp;
    }
    trace('Prefer audio send bitrate: ' + params.audioSendBitrate);
    return preferBitRate(sdp, params.audioSendBitrate, 'audio');
}

function maybeSetAudioReceiveBitRate(sdp, params) {
    if (!params.audioRecvBitrate) {
        return sdp;
    }
    trace('Prefer audio receive bitrate: ' + params.audioRecvBitrate);
    return preferBitRate(sdp, params.audioRecvBitrate, 'audio');
}

function maybeSetVideoSendBitRate(sdp, params) {
    if (!params.videoSendBitrate) {
        return sdp;
    }
    trace('Prefer video send bitrate: ' + params.videoSendBitrate);
    return preferBitRate(sdp, params.videoSendBitrate, 'video');
}

function maybeSetVideoReceiveBitRate(sdp, params) {
    if (!params.videoRecvBitrate) {
        return sdp;
    }
    trace('Prefer video receive bitrate: ' + params.videoRecvBitrate);
    return preferBitRate(sdp, params.videoRecvBitrate, 'video');
}

// Add a b=AS:bitrate line to the m=mediaType section.
function preferBitRate(sdp, bitrate, mediaType) {
    var sdpLines = sdp.split('\r\n');

    // Find m line for the given mediaType.
    var mLineIndex = findLine(sdpLines, 'm=', mediaType);
    if (mLineIndex === null) {
        trace('Failed to add bandwidth line to sdp, as no m-line found');
        return sdp;
    }

    // Find next m-line if any.
    var nextMLineIndex = findLineInRange(sdpLines, mLineIndex + 1, -1, 'm=');
    if (nextMLineIndex === null) {
        nextMLineIndex = sdpLines.length;
    }

    // Find c-line corresponding to the m-line.
    var cLineIndex = findLineInRange(sdpLines, mLineIndex + 1,
        nextMLineIndex, 'c=');
    if (cLineIndex === null) {
        trace('Failed to add bandwidth line to sdp, as no c-line found');
        return sdp;
    }

    // Check if bandwidth line already exists between c-line and next m-line.
    var bLineIndex = findLineInRange(sdpLines, cLineIndex + 1,
        nextMLineIndex, 'b=AS');
    if (bLineIndex) {
        sdpLines.splice(bLineIndex, 1);
    }

    // Create the b (bandwidth) sdp line.
    var bwLine = 'b=AS:' + bitrate;
    // As per RFC 4566, the b line should follow after c-line.
    sdpLines.splice(cLineIndex + 1, 0, bwLine);
    sdp = sdpLines.join('\r\n');
    return sdp;
}

// Add an a=fmtp: x-google-min-bitrate=kbps line, if videoSendInitialBitrate
// is specified. We'll also add a x-google-min-bitrate value, since the max
// must be >= the min.
function maybeSetVideoSendInitialBitRate(sdp, params) {
    var initialBitrate = parseInt(params.videoSendInitialBitrate);
    if (!initialBitrate) {
        return sdp;
    }

    // Validate the initial bitrate value.
    var maxBitrate = parseInt(initialBitrate);
    var bitrate = parseInt(params.videoSendBitrate);
    if (bitrate) {
        if (initialBitrate > bitrate) {
            trace('Clamping initial bitrate to max bitrate of ' + bitrate + ' kbps.');
            initialBitrate = bitrate;
            params.videoSendInitialBitrate = initialBitrate;
        }
        maxBitrate = bitrate;
    }

    var sdpLines = sdp.split('\r\n');

    // Search for m line.
    var mLineIndex = findLine(sdpLines, 'm=', 'video');
    if (mLineIndex === null) {
        trace('Failed to find video m-line');
        return sdp;
    }
    // Figure out the first codec payload type on the m=video SDP line.
    var videoMLine = sdpLines[mLineIndex];
    var pattern = new RegExp('m=video\\s\\d+\\s[A-Z/]+\\s');
    var sendPayloadType = videoMLine.split(pattern)[1].split(' ')[0];
    var fmtpLine = sdpLines[findLine(sdpLines, 'a=rtpmap', sendPayloadType)];
    var codecName = fmtpLine.split('a=rtpmap:' +
        sendPayloadType)[1].split('/')[0];

    // Use codec from params if specified via URL param, otherwise use from SDP.
    var codec = params.videoSendCodec || codecName;
    sdp = setCodecParam(sdp, codec, 'x-google-min-bitrate',
        params.videoSendInitialBitrate.toString());
    sdp = setCodecParam(sdp, codec, 'x-google-max-bitrate',
        maxBitrate.toString());

    return sdp;
}

function removePayloadTypeFromMline(mLine, payloadType) {
    mLine = mLine.split(' ');
    for (var i = 0; i < mLine.length; ++i) {
        if (mLine[i] === payloadType.toString()) {
            mLine.splice(i, 1);
        }
    }
    return mLine.join(' ');
}

function removeCodecByName(sdpLines, codec) {
    var index = findLine(sdpLines, 'a=rtpmap', codec);
    if (index === null) {
        return sdpLines;
    }
    var payloadType = getCodecPayloadTypeFromLine(sdpLines[index]);
    sdpLines.splice(index, 1);

    // Search for the video m= line and remove the codec.
    var mLineIndex = findLine(sdpLines, 'm=', 'video');
    if (mLineIndex === null) {
        return sdpLines;
    }
    sdpLines[mLineIndex] = removePayloadTypeFromMline(sdpLines[mLineIndex],
        payloadType);
    return sdpLines;
}

function removeCodecByPayloadType(sdpLines, payloadType) {
    var index = findLine(sdpLines, 'a=rtpmap', payloadType.toString());
    if (index === null) {
        return sdpLines;
    }
    sdpLines.splice(index, 1);

    // Search for the video m= line and remove the codec.
    var mLineIndex = findLine(sdpLines, 'm=', 'video');
    if (mLineIndex === null) {
        return sdpLines;
    }
    sdpLines[mLineIndex] = removePayloadTypeFromMline(sdpLines[mLineIndex],
        payloadType);
    return sdpLines;
}

function maybeRemoveVideoFec(sdp, params) {
    if (params.videoFec !== 'false') {
        return sdp;
    }

    var sdpLines = sdp.split('\r\n');

    var index = findLine(sdpLines, 'a=rtpmap', 'red');
    if (index === null) {
        return sdp;
    }
    var redPayloadType = getCodecPayloadTypeFromLine(sdpLines[index]);
    sdpLines = removeCodecByPayloadType(sdpLines, redPayloadType);

    sdpLines = removeCodecByName(sdpLines, 'ulpfec');

    // Remove fmtp lines associated with red codec.
    index = findLine(sdpLines, 'a=fmtp', redPayloadType.toString());
    if (index === null) {
        return sdp;
    }
    var fmtpLine = parseFmtpLine(sdpLines[index]);
    var rtxPayloadType = fmtpLine.pt;
    if (rtxPayloadType === null) {
        return sdp;
    }
    sdpLines.splice(index, 1);

    sdpLines = removeCodecByPayloadType(sdpLines, rtxPayloadType);
    return sdpLines.join('\r\n');
}

// Promotes |audioSendCodec| to be the first in the m=audio line, if set.
function maybePreferAudioSendCodec(sdp, params) {
    return maybePreferCodec(sdp, 'audio', 'send', params.audioSendCodec);
}

// Promotes |audioRecvCodec| to be the first in the m=audio line, if set.
function maybePreferAudioReceiveCodec(sdp, params) {
    return maybePreferCodec(sdp, 'audio', 'receive', params.audioRecvCodec);
}

// Promotes |videoSendCodec| to be the first in the m=audio line, if set.
function maybePreferVideoSendCodec(sdp, params) {
    return maybePreferCodec(sdp, 'video', 'send', params.videoSendCodec);
}

// Promotes |videoRecvCodec| to be the first in the m=audio line, if set.
function maybePreferVideoReceiveCodec(sdp, params) {
    return maybePreferCodec(sdp, 'video', 'receive', params.videoRecvCodec);
}

// Sets |codec| as the default |type| codec if it's present.
// The format of |codec| is 'NAME/RATE', e.g. 'opus/48000'.
function maybePreferCodec(sdp, type, dir, codec) {
    var str = type + ' ' + dir + ' codec';
    if (!codec) {
        trace('No preference on ' + str + '.');
        return sdp;
    }

    trace('Prefer ' + str + ': ' + codec);

    var sdpLines = sdp.split('\r\n');

    // Search for m line.
    var mLineIndex = findLine(sdpLines, 'm=', type);
    if (mLineIndex === null) {
        return sdp;
    }

    // If the codec is available, set it as the default in m line.
    var payload = null;
    // Iterate through rtpmap enumerations to find all matching codec entries
    for (var i = sdpLines.length-1; i >= 0 ; --i) {
        // Finds first match in rtpmap
        var index = findLineInRange(sdpLines, i, 0, 'a=rtpmap', codec, 'desc');
        if (index !== null) {
            // Skip all of the entries between i and index match
            i = index;
            payload = getCodecPayloadTypeFromLine(sdpLines[index]);
            if (payload) {
                // Move codec to top
                sdpLines[mLineIndex] = setDefaultCodec(sdpLines[mLineIndex], payload);
            }
        } else {
            // No match means we can break the loop
            break;
        }
    }

    sdp = sdpLines.join('\r\n');
    return sdp;
}

// Set fmtp param to specific codec in SDP. If param does not exists, add it.
function setCodecParam(sdp, codec, param, value) {
    var sdpLines = sdp.split('\r\n');

    var fmtpLineIndex = findFmtpLine(sdpLines, codec);

    var fmtpObj = {};
    if (fmtpLineIndex === null) {
        var index = findLine(sdpLines, 'a=rtpmap', codec);
        if (index === null) {
            return sdp;
        }
        var payload = getCodecPayloadTypeFromLine(sdpLines[index]);
        fmtpObj.pt = payload.toString();
        fmtpObj.params = {};
        fmtpObj.params[param] = value;
        sdpLines.splice(index + 1, 0, writeFmtpLine(fmtpObj));
    } else {
        fmtpObj = parseFmtpLine(sdpLines[fmtpLineIndex]);
        fmtpObj.params[param] = value;
        sdpLines[fmtpLineIndex] = writeFmtpLine(fmtpObj);
    }

    sdp = sdpLines.join('\r\n');
    return sdp;
}

// Remove fmtp param if it exists.
function removeCodecParam(sdp, codec, param) {
    var sdpLines = sdp.split('\r\n');

    var fmtpLineIndex = findFmtpLine(sdpLines, codec);
    if (fmtpLineIndex === null) {
        return sdp;
    }

    var map = parseFmtpLine(sdpLines[fmtpLineIndex]);
    delete map.params[param];

    var newLine = writeFmtpLine(map);
    if (newLine === null) {
        sdpLines.splice(fmtpLineIndex, 1);
    } else {
        sdpLines[fmtpLineIndex] = newLine;
    }

    sdp = sdpLines.join('\r\n');
    return sdp;
}

// Split an fmtp line into an object including 'pt' and 'params'.
function parseFmtpLine(fmtpLine) {
    var fmtpObj = {};
    var spacePos = fmtpLine.indexOf(' ');
    var keyValues = fmtpLine.substring(spacePos + 1).split(';');

    var pattern = new RegExp('a=fmtp:(\\d+)');
    var result = fmtpLine.match(pattern);
    if (result && result.length === 2) {
        fmtpObj.pt = result[1];
    } else {
        return null;
    }

    var params = {};
    for (var i = 0; i < keyValues.length; ++i) {
        var pair = keyValues[i].split('=');
        if (pair.length === 2) {
            params[pair[0]] = pair[1];
        }
    }
    fmtpObj.params = params;

    return fmtpObj;
}

// Generate an fmtp line from an object including 'pt' and 'params'.
function writeFmtpLine(fmtpObj) {
    if (!fmtpObj.hasOwnProperty('pt') || !fmtpObj.hasOwnProperty('params')) {
        return null;
    }
    var pt = fmtpObj.pt;
    var params = fmtpObj.params;
    var keyValues = [];
    var i = 0;
    for (var key in params) {
        keyValues[i] = key + '=' + params[key];
        ++i;
    }
    if (i === 0) {
        return null;
    }
    return 'a=fmtp:' + pt.toString() + ' ' + keyValues.join(';');
}

// Find fmtp attribute for |codec| in |sdpLines|.
function findFmtpLine(sdpLines, codec) {
    // Find payload of codec.
    var payload = getCodecPayloadType(sdpLines, codec);
    // Find the payload in fmtp line.
    return payload ? findLine(sdpLines, 'a=fmtp:' + payload.toString()) : null;
}

// Find the line in sdpLines that starts with |prefix|, and, if specified,
// contains |substr| (case-insensitive search).
function findLine(sdpLines, prefix, substr) {
    return findLineInRange(sdpLines, 0, -1, prefix, substr);
}

// Find the line in sdpLines[startLine...endLine - 1] that starts with |prefix|
// and, if specified, contains |substr| (case-insensitive search).
function findLineInRange(
    sdpLines,
    startLine,
    endLine,
    prefix,
    substr,
    direction
) {
    if (direction === undefined) {
        direction = 'asc';
    }

    direction = direction || 'asc';

    if (direction === 'asc') {
        // Search beginning to end
        var realEndLine = endLine !== -1 ? endLine : sdpLines.length;
        for (var i = startLine; i < realEndLine; ++i) {
            if (sdpLines[i].indexOf(prefix) === 0) {
                if (!substr ||
                    sdpLines[i].toLowerCase().indexOf(substr.toLowerCase()) !== -1) {
                    return i;
                }
            }
        }
    } else {
        // Search end to beginning
        var realStartLine = startLine !== -1 ? startLine : sdpLines.length-1;
        for (var j = realStartLine; j >= 0; --j) {
            if (sdpLines[j].indexOf(prefix) === 0) {
                if (!substr ||
                    sdpLines[j].toLowerCase().indexOf(substr.toLowerCase()) !== -1) {
                    return j;
                }
            }
        }
    }
    return null;
}

// Gets the codec payload type from sdp lines.
function getCodecPayloadType(sdpLines, codec) {
    var index = findLine(sdpLines, 'a=rtpmap', codec);
    return index ? getCodecPayloadTypeFromLine(sdpLines[index]) : null;
}

// Gets the codec payload type from an a=rtpmap:X line.
function getCodecPayloadTypeFromLine(sdpLine) {
    var pattern = new RegExp('a=rtpmap:(\\d+) [a-zA-Z0-9-]+\\/\\d+');
    var result = sdpLine.match(pattern);
    return (result && result.length === 2) ? result[1] : null;
}

// Returns a new m= line with the specified codec as the first one.
function setDefaultCodec(mLine, payload) {
    var elements = mLine.split(' ');

    // Just copy the first three parameters; codec order starts on fourth.
    var newLine = elements.slice(0, 3);

    // Put target payload first and copy in the rest.
    newLine.push(payload);
    for (var i = 3; i < elements.length; i++) {
        if (elements[i] !== payload) {
            newLine.push(elements[i]);
        }
    }
    return newLine.join(' ');
}

export default class Signaling extends events.EventEmitter {

    constructor(url, name) {
        super();
        this.socket = null;
        this.peer_connections = {};
        this.session_id = '0-0';
        this.self_id = 0;
        this.url = url;
        this.name = name;
        this.local_stream;
        this.keepalive_cnt = 0;

        RTCPeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection || window.msRTCPeerConnection;
        RTCSessionDescription = window.RTCSessionDescription || window.mozRTCSessionDescription || window.webkitRTCSessionDescription || window.msRTCSessionDescription;
        navigator.getUserMedia = navigator.getUserMedia || navigator.mozGetUserMedia || navigator.webkitGetUserMedia || navigator.msGetUserMedia;


        if (browser.safari) {
            var OrigPeerConnection = RTCPeerConnection;
            RTCPeerConnection = function (pcConfig, pcConstraints) {
                if (pcConfig && pcConfig.iceServers) {
                    var newIceServers = [];
                    for (var i = 0; i < pcConfig.iceServers.length; i++) {
                        var server = pcConfig.iceServers[i];
                        if (!server.hasOwnProperty('urls') &&
                            server.hasOwnProperty('url')) {
                            // utils.deprecated('RTCIceServer.url', 'RTCIceServer.urls');
                            server = JSON.parse(JSON.stringify(server));
                            server.urls = server.url;
                            delete server.url;
                            newIceServers.push(server);
                        } else {
                            newIceServers.push(pcConfig.iceServers[i]);
                        }
                    }
                    pcConfig.iceServers = newIceServers;
                }
                return new OrigPeerConnection(pcConfig, pcConstraints);
            };
        }
        var twilioIceServers = [
            {url: 'stun:global.stun.twilio.com:3478?transport=udp'}
        ];

        configuration = {"iceServers": [{"url": "stun:stun.l.google.com:19302"}]};

        this.socket = new WebSocket(this.url);
        this.socket.onopen = () => {
            console.log("wss connect success...");
            this.self_id = this.getRandomUserId();
            let message = {
                type: 'new',
                user_agent: browser.name + '/' + browser.version,
                name: this.name,
                id: this.self_id,
            }
            this.send(message);
            this.wsKeepaliveTimeoutId = setInterval(this.keepAlive, 12000);
        };

        this.socket.onmessage = (e) => {

            var parsedMessage = JSON.parse(e.data);

            console.info('on message: {\n    type = ' + parsedMessage.type + ', \n    data = ' + JSON.stringify(parsedMessage.data) + '\n}');

            switch (parsedMessage.type) {
                case 'invite':
                    this.onInvite(parsedMessage);
                    break;
                case 'ringing':
                    this.onRinging(parsedMessage);
                    break;
                case 'offer':
                    this.onOffer(parsedMessage);
                    break;
                case 'answer':
                    this.onAnswer(parsedMessage);
                    break;
                case 'candidate':
                    this.onCandidate(parsedMessage);
                    break;
                case 'peers':
                    this.onPeers(parsedMessage);
                    break;
                case 'leave':
                    this.onLeave(parsedMessage);
                    break;
                case 'bye':
                    this.onBye(parsedMessage);
                    break;
                case 'keepalive':
                    console.log('keepalive response!');
                    break;
                default:
                    console.error('Unrecognized message', parsedMessage);
            }
        };

        this.socket.onerror = (e) => {
            console.log('onerror::' + e.data);
        }

        this.socket.onclose = (e) => {
            console.log('onclose::' + e.data);
        }
    }

    keepAlive = () => {
        this.send({type: 'keepalive', data: {}});
        console.log('Sent keepalive ' + ++this.keepalive_cnt + ' times!');
    }

    getLocalStream = (type) => {
        return new Promise((pResolve, pReject) => {
            var constraints = {
                audio: true,
                video: (type === 'video') ? {width: 1280, height: 720} : false
            };
            var that = this;
            navigator.mediaDevices.getUserMedia(constraints)
                .then(function (mediaStream) {
                    pResolve(mediaStream);
                }).catch((err) => {
                    console.log(err.name + ": " + err.message);
                    pReject(err);
                }
            );
        });
    }

    // 获取6位随机id
    getRandomUserId() {
        var num = "";
        for (var i = 0; i < 6; i++) {
            num += Math.floor(Math.random() * 10);
        }
        return num;
    }

    send = (data) => {
        this.socket.send(JSON.stringify(data));
    }

    invite = (peer_id, media) => {
        this.session_id = this.self_id + '-' + peer_id;
        this.getLocalStream(media).then((stream) => {
            this.local_stream = stream;
            this.createPeerConnection(peer_id, media, true, stream);
            this.emit('localstream', stream);
            this.emit('new_call', this.self_id, this.session_id);
        });
    }

    bye = () => {
        let message = {
            type: 'bye',
            session_id: this.session_id,
            from: this.self_id,
        }
        this.send(message);
    }

    createOffer = (pc, id, media) => {
        pc.createOffer((desc) => {
            console.log('createOffer (before): ', desc.sdp);
            desc.sdp = maybeSetOpusOptions(desc.sdp, {opusStereo: 'true'});
            console.log('createOffer (after): ', desc.sdp);
            pc.setLocalDescription(desc, () => {
                console.log('setLocalDescription', pc.localDescription);
                let message = {
                    type: 'offer',
                    to: id,
                    media: media,
                    description: pc.localDescription,
                    session_id: this.session_id,
                }
                this.send(message);
            }, this.logError);
        }, this.logError);
    }

    createPeerConnection = (id, media, isOffer, localstream) => {
        var pc = new RTCPeerConnection(configuration);
        this.peer_connections["" + id] = pc;
        pc.onicecandidate = (event) => {
            console.log('onicecandidate', event);
            if (event.candidate) {
                let message = {
                    type: 'candidate',
                    to: id,
                    candidate: event.candidate,
                    session_id: this.session_id,
                }
                this.send(message);
            }
        };

        pc.onnegotiationneeded = () => {
            console.log('onnegotiationneeded');
        }

        pc.oniceconnectionstatechange = (event) => {
            console.log('oniceconnectionstatechange', event);
            if (event.target.iceConnectionState === 'connected') {
                this.createDataChannel(pc);
            }
        };
        pc.onsignalingstatechange = (event) => {
            console.log('onsignalingstatechange', event);
        };

        pc.onaddstream = (event) => {
            console.log('onaddstream', event);
            this.emit('addstream', event.stream);
        };

        pc.onremovestream = (event) => {
            console.log('onremovestream', event);
            this.emit('removestream', event.stream);
        };

        pc.addStream(localstream);

        if (isOffer)
            this.createOffer(pc, id, media);
        return pc;
    }

    createDataChannel = (pc) => {
        if (pc.textDataChannel) {
            return;
        }
        var dataChannel = pc.createDataChannel("text");

        dataChannel.onerror = (error) => {
            console.log("dataChannel.onerror", error);
        };

        dataChannel.onmessage = (event) => {
            console.log("dataChannel.onmessage:", event.data);
            var content = document.getElementById('textRoomContent');
            //content.innerHTML = content.innerHTML + '<p>' + socketId + ': ' + event.data + '</p>';
        };

        dataChannel.onopen = () => {
            console.log('dataChannel.onopen');
        };

        dataChannel.onclose = () => {
            console.log("dataChannel.onclose");
        };

        pc.textDataChannel = dataChannel;
    }

    onPeers = (message) => {
        var data = message.data;
        console.log("peers = " + JSON.stringify(data));
        this.emit('peers', data, this.self_id);
    }

    onOffer = (message) => {
        var data = message.data;
        var from = data.from;
        console.log("data:" + data);
        var media = data.media;
        this.session_id = data.session_id;
        this.emit('new_call', from, this.session_id);

        this.getLocalStream(media).then((stream) => {
            this.local_stream = stream;
            this.emit('localstream', stream);
            var pc = this.createPeerConnection(from, media, false, stream);

            if (pc && data.description) {
                //console.log('on offer sdp', data);
                pc.setRemoteDescription(new RTCSessionDescription(data.description), () => {
                    if (pc.remoteDescription.type == "offer")
                        pc.createAnswer((desc) => {
                            console.log('createAnswer (before): ', desc);

                            desc.sdp = maybeSetOpusOptions(desc.sdp, {opusStereo: 'true'});

                            console.log('createAnswer (after): ', desc);
                            pc.setLocalDescription(desc, () => {
                                console.log('setLocalDescription', pc.localDescription);
                                let message = {
                                    type: 'answer',
                                    to: from,
                                    description: pc.localDescription,
                                    session_id: this.session_id,
                                }
                                this.send(message);
                            }, this.logError);
                        }, this.logError);
                }, this.logError);
            }
        });
    }

    onAnswer = (message) => {
        var data = message.data;
        var from = data.from;
        var pc = null;
        if (from in this.peer_connections) {
            pc = this.peer_connections[from];
        }
        if (pc && data.description) {
            //console.log('on answer sdp', data);
            pc.setRemoteDescription(new RTCSessionDescription(data.description), () => {
            }, this.logError);
        }
    }

    onCandidate = (message) => {
        var data = message.data;
        var from = data.from;
        var pc = null;
        if (from in this.peer_connections) {
            pc = this.peer_connections[from];
        }
        if (pc && data.candidate) {
            pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
    }

    onLeave = (message) => {
        var id = message.data;
        console.log('leave', id);
        var peerConnections = this.peer_connections;
        var pc = peerConnections[id];
        if (pc !== undefined) {
            pc.close();
            delete peerConnections[id];
            this.emit('leave', id);
        }
        if (this.local_stream != null) {
            this.closeMediaStream(this.local_stream);
            this.local_stream = null;
        }
    }

    onBye = (message) => {
        var data = message.data;
        var from = data.from;
        var to = data.to;
        console.log('bye: ', data.session_id);
        var peerConnections = this.peer_connections;
        var pc = peerConnections[to] || peerConnections[from];
        if (pc !== undefined) {
            pc.close();
            delete peerConnections[to];
            this.emit('call_end', to, this.session_id);
        }
        if (this.local_stream != null) {
            this.closeMediaStream(this.local_stream);
            this.local_stream = null;
        }
        this.session_id = '0-0';
    }

    logError = (error) => {
        console.log("logError", error);
    }

    sendText() {
        var text = "test send text...";//document.getElementById('textRoomInput').value;
        if (text == "") {
            alert('Enter something');
        } else {
            //document.getElementById('textRoomInput').value = '';
            // var content = document.getElementById('textRoomContent');
            // content.innerHTML = content.innerHTML + '<p>' + 'Me' + ': ' + text + '</p>';
            for (var key in this.peer_connections) {
                var pc = this.peer_connections[key];
                pc.textDataChannel.send(text);
            }
        }
    }

    closeMediaStream = (stream) => {
        if (!stream)
            return;

        let tracks = stream.getTracks();

        for (let i = 0, len = tracks.length; i < len; i++) {
            tracks[i].stop();
        }
    }
}