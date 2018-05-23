/*
 * (C) Copyright 2017-2018 OpenVidu (https://openvidu.io/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { Connection } from './Connection';
import { MediaManager } from './MediaManager';
import { Session } from './Session';
import { InboundStreamOptions } from '../OpenViduInternal/Interfaces/Private/InboundStreamOptions';
import { OutboundStreamOptions } from '../OpenViduInternal/Interfaces/Private/OutboundStreamOptions';
import { WebRtcStats } from '../OpenViduInternal/WebRtcStats/WebRtcStats';
import { PublisherSpeakingEvent } from '../OpenViduInternal/Events/PublisherSpeakingEvent';
import { VideoInsertMode } from '../OpenViduInternal/Enums/VideoInsertMode';

import EventEmitter = require('wolfy87-eventemitter');

import * as kurentoUtils from '../OpenViduInternal/KurentoUtils/kurento-utils-js';


/**
 * Represents each one of the videos send and receive by a user in a session.
 * Therefore each [[Publisher]] and [[Subscriber]] has an attribute of type Stream
 */
export class Stream {

    /**
     * The Connection object that is publishing the stream
     */
    connection: Connection;

    /**
     * Frame rate of the video in frames per second. This property is only defined if the [[Publisher]] of the stream was initialized passing a _frameRate_ property on [[OpenVidu.initPublisher]] method
     */
    frameRate?: number;

    /**
     * Whether the stream has a video track or not
     */
    hasVideo: boolean;

    /**
     * Whether the stream has an audio track or not
     */
    hasAudio: boolean;

    /**
     * Unique identifier of the stream
     */
    streamId: string;

    /**
     * `"CAMERA"` or `"SCREEN"`. undefined if stream is audio-only
     */
    typeOfVideo?: string;

    /**
     * Array of [[MediaManager]] objects displaying this stream in the DOM
     */
    mediaManagers: MediaManager[] = [];

    private ee = new EventEmitter();

    private webRtcPeer: any;
    private mediaStream: MediaStream;
    private webRtcStats: WebRtcStats;

    private isSubscribeToRemote = false;

    /**
     * @hidden
     */
    isLocalStreamReadyToPublish = false;
    /**
     * @hidden
     */
    isLocalStreamPublished = false;
    /**
     * @hidden
     */
    session: Session;
    /**
     * @hidden
     */
    inboundStreamOpts: InboundStreamOptions;
    /**
     * @hidden
     */
    outboundStreamOpts: OutboundStreamOptions;
    /**
     * @hidden
     */
    speechEvent: any;


    /**
     * @hidden
     */
    constructor(session: Session, options: InboundStreamOptions | OutboundStreamOptions | {}) {

        this.session = session;

        if (options.hasOwnProperty('id')) {
            // InboundStreamOptions: stream belongs to a Subscriber
            this.inboundStreamOpts = <InboundStreamOptions>options;
            this.streamId = this.inboundStreamOpts.id;
            this.hasAudio = this.inboundStreamOpts.recvAudio;
            this.hasVideo = this.inboundStreamOpts.recvVideo;
            this.typeOfVideo = (!this.inboundStreamOpts.typeOfVideo) ? undefined : this.inboundStreamOpts.typeOfVideo;
            this.frameRate = (this.inboundStreamOpts.frameRate === -1) ? undefined : this.inboundStreamOpts.frameRate;
        } else {
            // OutboundStreamOptions: stream belongs to a Publisher
            this.outboundStreamOpts = <OutboundStreamOptions>options;

            if (this.isSendVideo()) {
                if (this.isSendScreen()) {
                    this.streamId = 'SCREEN';
                    this.typeOfVideo = 'SCREEN';
                } else {
                    this.streamId = 'CAMERA';
                    this.typeOfVideo = 'CAMERA';
                }
                this.frameRate = this.outboundStreamOpts.publisherProperties.frameRate;
            } else {
                this.streamId = 'MICRO';
                delete this.typeOfVideo;
            }
            this.hasAudio = this.isSendAudio();
            this.hasVideo = this.isSendVideo();
        }

        this.on('mediastream-updated', () => {
            this.mediaManagers.forEach(mediaManager => {
                if (!!mediaManager.video) {
                    mediaManager.video.srcObject = this.mediaStream;
                }
            });
            console.debug('Video srcObject [' + this.mediaStream + '] updated in stream [' + this.streamId + ']');
        });
    }

    /**
     * Makes `video` element parameter display this Stream. This is useful when you are managing the video elements on your own
     * (parameter `targetElement` of methods [[OpenVidu.initPublisher]] or [[Session.subscribe]] is set to *null* or *undefined*)
     * or if you want to have multiple video elements display the same media stream
     */
    addVideoElement(video: HTMLVideoElement): MediaManager {
        video.srcObject = this.mediaStream;
        const mediaManager = new MediaManager(this);
        mediaManager.video = video;
        mediaManager.id = video.id;
        mediaManager.isVideoElementCreated = true;
        mediaManager.remote = !this.isLocal();
        return mediaManager;
    }


    /* Hidden methods */

    /**
     * @hidden
     */
    getMediaStream(): MediaStream {
        return this.mediaStream;
    }

    /**
     * @hidden
     */
    setMediaStream(mediaStream: MediaStream): void {
        this.mediaStream = mediaStream;
        this.ee.emitEvent('mediastream-updated');
    }

    /**
     * @hidden
     */
    getWebRtcPeer(): any {
        return this.webRtcPeer;
    }

    /**
     * @hidden
     */
    getRTCPeerConnection(): RTCPeerConnection {
        return this.webRtcPeer.peerConnection;
    }

    /**
     * @hidden
     */
    subscribeToMyRemote(): void {
        this.isSubscribeToRemote = true;
    }

    /**
     * @hidden
     */
    setOutboundStreamOptions(outboundStreamOpts: OutboundStreamOptions): void {
        this.outboundStreamOpts = outboundStreamOpts;
    }

    /**
     * @hidden
     */
    subscribe(): Promise<any> {
        return new Promise((resolve, reject) => {
            this.initWebRtcPeerReceive()
                .then(() => {
                    resolve();
                })
                .catch(error => {
                    reject(error);
                });
        });
    }

    /**
     * @hidden
     */
    publish(): Promise<any> {
        return new Promise((resolve, reject) => {
            if (this.isLocalStreamReadyToPublish) {
                this.initWebRtcPeerSend()
                    .then(() => {
                        resolve();
                    })
                    .catch(error => {
                        reject(error);
                    });
            } else {
                this.ee.once('stream-ready-to-publish', streamEvent => {
                    this.publish()
                        .then(() => {
                            resolve();
                        })
                        .catch(error => {
                            reject(error);
                        });
                });
            }
        });
    }

    /**
     * @hidden
     */
    disposeWebRtcPeer(): void {
        if (this.webRtcPeer) {
            this.webRtcPeer.dispose();
        }
        if (this.speechEvent) {
            this.speechEvent.stop();
        }

        this.stopWebRtcStats();

        console.info((!!this.outboundStreamOpts ? 'Outbound ' : 'Inbound ') + "WebRTCPeer from 'Stream' with id [" + this.streamId + '] is now closed');
    }

    /**
     * @hidden
     */
    disposeMediaStream(): void {
        if (this.mediaStream) {
            this.mediaStream.getAudioTracks().forEach((track) => {
                track.stop();
            });
            this.mediaStream.getVideoTracks().forEach((track) => {
                track.stop();
            });
        }
        console.info((!!this.outboundStreamOpts ? 'Local ' : 'Remote ') + "MediaStream from 'Stream' with id [" + this.streamId + '] is now disposed');
    }

    /**
     * @hidden
     */
    displayMyRemote(): boolean {
        return this.isSubscribeToRemote;
    }

    /**
     * @hidden
     */
    on(eventName: string, listener: any): void {
        this.ee.on(eventName, listener);
    }

    /**
     * @hidden
     */
    once(eventName: string, listener: any): void {
        this.ee.once(eventName, listener);
    }

    /**
     * @hidden
     */
    isSendAudio(): boolean {
        return (!!this.outboundStreamOpts &&
            this.outboundStreamOpts.publisherProperties.audioSource !== null &&
            this.outboundStreamOpts.publisherProperties.audioSource !== false);
    }

    /**
     * @hidden
     */
    isSendVideo(): boolean {
        return (!!this.outboundStreamOpts &&
            this.outboundStreamOpts.publisherProperties.videoSource !== null &&
            this.outboundStreamOpts.publisherProperties.videoSource !== false);
    }

    /**
     * @hidden
     */
    isSendScreen(): boolean {
        return (!!this.outboundStreamOpts &&
            this.outboundStreamOpts.publisherProperties.videoSource === 'screen');
    }

    /**
     * @hidden
     */
    emitEvent(type: string, eventArray: any[]): void {
        this.ee.emitEvent(type, eventArray);
    }

    /**
     * @hidden
     */
    setSpeechEventIfNotExists(): void {
        if (!this.speechEvent) {
            const harkOptions = this.session.openvidu.advancedConfiguration.publisherSpeakingEventsOptions || {};
            harkOptions.interval = (typeof harkOptions.interval === 'number') ? harkOptions.interval : 50;
            harkOptions.threshold = (typeof harkOptions.threshold === 'number') ? harkOptions.threshold : -50;

            this.speechEvent = kurentoUtils.WebRtcPeer.hark(this.mediaStream, harkOptions);
        }
    }

    /**
     * @hidden
     */
    enableSpeakingEvents(): void {
        this.setSpeechEventIfNotExists();
        this.speechEvent.on('speaking', () => {
            this.session.emitEvent('publisherStartSpeaking', [new PublisherSpeakingEvent(this.session, 'publisherStartSpeaking', this.connection, this.streamId)]);
        });
        this.speechEvent.on('stopped_speaking', () => {
            this.session.emitEvent('publisherStopSpeaking', [new PublisherSpeakingEvent(this.session, 'publisherStopSpeaking', this.connection, this.streamId)]);
        });
    }

    /**
     * @hidden
     */
    enableOnceSpeakingEvents(): void {
        this.setSpeechEventIfNotExists();
        this.speechEvent.on('speaking', () => {
            this.session.emitEvent('publisherStartSpeaking', [new PublisherSpeakingEvent(this.session, 'publisherStartSpeaking', this.connection, this.streamId)]);
            this.disableSpeakingEvents();
        });
        this.speechEvent.on('stopped_speaking', () => {
            this.session.emitEvent('publisherStopSpeaking', [new PublisherSpeakingEvent(this.session, 'publisherStopSpeaking', this.connection, this.streamId)]);
            this.disableSpeakingEvents();
        });
    }

    /**
     * @hidden
     */
    disableSpeakingEvents(): void {
        this.speechEvent.stop();
        this.speechEvent = undefined;
    }

    /**
     * @hidden
     */
    removeVideos(): void {
        this.mediaManagers.forEach(mediaManager => {
            mediaManager.removeVideo();
        });
    }


    /* Private methods */

    private initWebRtcPeerSend(): Promise<any> {
        return new Promise((resolve, reject) => {

            const userMediaConstraints = {
                audio: this.isSendAudio(),
                video: this.isSendVideo()
            };

            const options: any = {
                videoStream: this.mediaStream,
                mediaConstraints: userMediaConstraints,
                onicecandidate: this.connection.sendIceCandidate.bind(this.connection),
                iceServers: this.session.openvidu.advancedConfiguration.iceServers
            };

            const successCallback = (error, sdpOfferParam, wp) => {
                if (error) {
                    reject(new Error('(publish) SDP offer error: ' + JSON.stringify(error)));
                }

                console.debug('Sending SDP offer to publish as '
                    + this.streamId, sdpOfferParam);

                this.session.openvidu.sendRequest('publishVideo', {
                    sdpOffer: sdpOfferParam,
                    doLoopback: this.displayMyRemote() || false,
                    audioActive: this.isSendAudio(),
                    videoActive: this.isSendVideo(),
                    typeOfVideo: ((this.isSendVideo()) ? (this.isSendScreen() ? 'SCREEN' : 'CAMERA') : ''),
                    frameRate: !!this.frameRate ? this.frameRate : -1
                }, (error, response) => {
                    if (error) {
                        reject('Error on publishVideo: ' + JSON.stringify(error));
                    } else {
                        this.processSdpAnswer(response.sdpAnswer)
                            .then(() => {
                                this.ee.emitEvent('stream-created-by-publisher');
                                resolve();
                            })
                            .catch(error => {
                                reject(error);
                            });
                        console.info("'Publisher' successfully published to session");
                    }
                });
            };

            if (this.displayMyRemote()) {
                this.webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerSendrecv(options, err => {
                    if (err) {
                        reject(err);
                    }
                    this.webRtcPeer.generateOffer(successCallback);
                });
            } else {
                this.webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(options, error => {
                    if (error) {
                        reject(error);
                    }
                    this.webRtcPeer.generateOffer(successCallback);
                });
            }
            this.isLocalStreamPublished = true;
        });
    }

    private initWebRtcPeerReceive(): Promise<any> {
        return new Promise((resolve, reject) => {

            const offerConstraints = {
                audio: this.inboundStreamOpts.recvAudio,
                video: this.inboundStreamOpts.recvVideo
            };
            console.debug("'Session.subscribe(Stream)' called. Constraints of generate SDP offer",
                offerConstraints);
            const options = {
                onicecandidate: this.connection.sendIceCandidate.bind(this.connection),
                mediaConstraints: offerConstraints
            };

            const successCallback = (error, sdpOfferParam, wp) => {

                if (error) {
                    reject(new Error('(subscribe) SDP offer error: ' + JSON.stringify(error)));
                }
                console.debug('Sending SDP offer to subscribe to '
                    + this.streamId, sdpOfferParam);
                this.session.openvidu.sendRequest('receiveVideoFrom', {
                    sender: this.streamId,
                    sdpOffer: sdpOfferParam
                }, (error, response) => {
                    if (error) {
                        reject(new Error('Error on recvVideoFrom: ' + JSON.stringify(error)));
                    } else {
                        this.processSdpAnswer(response.sdpAnswer).then(() => {
                            resolve();
                        }).catch(error => {
                            reject(error);
                        });
                    }
                });
            };

            this.webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options, error => {
                if (error) {
                    reject(error);
                }
                this.webRtcPeer.generateOffer(successCallback);
            });
        });
    }

    private processSdpAnswer(sdpAnswer): Promise<any> {
        return new Promise((resolve, reject) => {
            const answer = new RTCSessionDescription({
                type: 'answer',
                sdp: sdpAnswer,
            });

            console.debug(this.streamId + ': set peer connection with recvd SDP answer', sdpAnswer);

            const streamId = this.streamId;
            const peerConnection = this.webRtcPeer.peerConnection;
            peerConnection.setRemoteDescription(answer, () => {

                // Avoids to subscribe to your own stream remotely
                // except when showMyRemote is true
                if (!this.isLocal() || this.displayMyRemote()) {
                    this.mediaStream = peerConnection.getRemoteStreams()[0];
                    console.debug('Peer remote stream', this.mediaStream);

                    if (!!this.mediaStream) {

                        this.ee.emitEvent('mediastream-updated');

                        if (!!this.mediaStream.getAudioTracks()[0] && this.session.speakingEventsEnabled) {
                            this.enableSpeakingEvents();
                        }
                    }

                    this.mediaManagers.forEach(mediaManager => {
                        mediaManager.addOnCanPlayEvent();
                    });
                    this.session.emitEvent('stream-subscribed', [{
                        stream: this
                    }]);
                }

                this.initWebRtcStats();
                resolve();

            }, error => {
                reject(new Error(this.streamId + ': Error setting SDP to the peer connection: ' + JSON.stringify(error)));
            });
        });
    }

    private initWebRtcStats(): void {
        this.webRtcStats = new WebRtcStats(this);
        this.webRtcStats.initWebRtcStats();
    }

    private stopWebRtcStats(): void {
        if (!!this.webRtcStats && this.webRtcStats.isEnabled()) {
            this.webRtcStats.stopWebRtcStats();
        }
    }

    /**
     * @hidden
     */
    isLocal(): boolean {
        // inbound options undefined and outbound options defined
        return (!this.inboundStreamOpts && !!this.outboundStreamOpts);
    }

}