package com.raven.app.rtc;

import android.content.Context;
import android.util.Log;

import androidx.annotation.Nullable;

import com.raven.app.net.RealtimeSocket;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.webrtc.Camera2Enumerator;
import org.webrtc.CameraEnumerator;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.MediaStreamTrack;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpTransceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoCapturer;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * Manages a small mesh of peer connections (up to 4 participants total).
 * Mesh is fine at this size — no SFU needed.
 *
 * Signaling is relayed through {@link RealtimeSocket} using message types:
 *   rtc-offer, rtc-answer, rtc-ice
 * which are already handled by the existing /rt server relay.
 */
public class WebRtcManager {

    public interface Listener {
        /** Called when a remote video track arrives for a peer. */
        void onRemoteTrack(String peerId, String displayName, VideoTrack track);
        /** Called when a peer leaves or its connection closes. */
        void onPeerGone(String peerId);
    }

    private static final String TAG = "WebRtcManager";

    private final Context appContext;
    private final RealtimeSocket socket;
    private final EglBase eglBase;
    private final PeerConnectionFactory factory;
    private final List<PeerConnection.IceServer> iceServers;

    private VideoCapturer capturer;
    private VideoSource videoSource;
    private SurfaceTextureHelper surfaceHelper;
    private VideoTrack localVideoTrack;
    @Nullable private Listener listener;

    private final Map<String, PeerConnection> peers = new HashMap<>();
    private final Map<String, String> peerNames = new HashMap<>();

    public WebRtcManager(Context context, RealtimeSocket socket) {
        this.appContext = context.getApplicationContext();
        this.socket = socket;
        this.eglBase = EglBase.create();

        PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(appContext)
                        .setEnableInternalTracer(false)
                        .createInitializationOptions());

        this.factory = PeerConnectionFactory.builder()
                .setAudioDeviceModule(JavaAudioDeviceModule.builder(appContext).createAudioDeviceModule())
                .setVideoEncoderFactory(new DefaultVideoEncoderFactory(eglBase.getEglBaseContext(), true, true))
                .setVideoDecoderFactory(new DefaultVideoDecoderFactory(eglBase.getEglBaseContext()))
                .createPeerConnectionFactory();

        this.iceServers = new ArrayList<>();
        this.iceServers.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());
    }

    public EglBase.Context eglContext() { return eglBase.getEglBaseContext(); }

    public void setListener(Listener l) { this.listener = l; }

    public void initLocalRenderer(SurfaceViewRenderer renderer) {
        renderer.init(eglBase.getEglBaseContext(), null);
        renderer.setMirror(true);
    }

    public void initRemoteRenderer(SurfaceViewRenderer renderer) {
        renderer.init(eglBase.getEglBaseContext(), null);
        renderer.setMirror(false);
    }

    /** Start the front camera and return the local track. */
    public VideoTrack startLocalCamera() {
        if (localVideoTrack != null) return localVideoTrack;

        capturer = createCameraCapturer();
        if (capturer == null) {
            Log.w(TAG, "no camera available");
            return null;
        }
        videoSource = factory.createVideoSource(capturer.isScreencast());
        surfaceHelper = SurfaceTextureHelper.create("CaptureThread", eglBase.getEglBaseContext());
        capturer.initialize(surfaceHelper, appContext, videoSource.getCapturerObserver());
        capturer.startCapture(640, 480, 24);

        localVideoTrack = factory.createVideoTrack("RAVEN_V0", videoSource);
        return localVideoTrack;
    }

    public void stopLocalCamera() {
        try { if (capturer != null) capturer.stopCapture(); } catch (InterruptedException ignored) {}
        if (capturer != null) { capturer.dispose(); capturer = null; }
        if (surfaceHelper != null) { surfaceHelper.dispose(); surfaceHelper = null; }
        if (videoSource != null) { videoSource.dispose(); videoSource = null; }
        localVideoTrack = null;
    }

    private VideoCapturer createCameraCapturer() {
        CameraEnumerator enumerator = new Camera2Enumerator(appContext);
        String[] names = enumerator.getDeviceNames();
        for (String name : names) {
            if (enumerator.isFrontFacing(name)) {
                VideoCapturer c = enumerator.createCapturer(name, null);
                if (c != null) return c;
            }
        }
        for (String name : names) {
            VideoCapturer c = enumerator.createCapturer(name, null);
            if (c != null) return c;
        }
        return null;
    }

    /** Send an offer to a new peer. */
    public void startCall(String peerId, String displayName) {
        PeerConnection pc = ensurePeer(peerId, displayName);
        if (pc == null) return;
        pc.createOffer(new SimpleSdp() {
            @Override public void onCreateSuccess(SessionDescription sdp) {
                pc.setLocalDescription(new SimpleSdp(), sdp);
                sendSignal("rtc-offer", peerId, toJson(sdp));
            }
        }, new MediaConstraints());
    }

    /** Handle an incoming signaling message (rtc-offer/answer/ice). */
    public void onSignal(JSONObject msg) {
        String type = msg.optString("type");
        String from = msg.optString("from");
        String name = msg.optString("name");
        if (from == null || from.isEmpty()) return;

        switch (type) {
            case "rtc-offer": {
                PeerConnection pc = ensurePeer(from, name);
                if (pc == null) return;
                SessionDescription desc = new SessionDescription(
                        SessionDescription.Type.OFFER, msg.optJSONObject("sdp") != null
                        ? msg.optJSONObject("sdp").optString("sdp") : msg.optString("sdp"));
                pc.setRemoteDescription(new SimpleSdp(), desc);
                pc.createAnswer(new SimpleSdp() {
                    @Override public void onCreateSuccess(SessionDescription answer) {
                        pc.setLocalDescription(new SimpleSdp(), answer);
                        sendSignal("rtc-answer", from, toJson(answer));
                    }
                }, new MediaConstraints());
                break;
            }
            case "rtc-answer": {
                PeerConnection pc = peers.get(from);
                if (pc == null) return;
                SessionDescription desc = new SessionDescription(
                        SessionDescription.Type.ANSWER, msg.optJSONObject("sdp") != null
                        ? msg.optJSONObject("sdp").optString("sdp") : msg.optString("sdp"));
                pc.setRemoteDescription(new SimpleSdp(), desc);
                break;
            }
            case "rtc-ice": {
                PeerConnection pc = peers.get(from);
                if (pc == null) return;
                JSONObject c = msg.optJSONObject("candidate");
                if (c == null) return;
                pc.addIceCandidate(new IceCandidate(
                        c.optString("sdpMid"),
                        c.optInt("sdpMLineIndex"),
                        c.optString("candidate")));
                break;
            }
            case "rtc-close":
            case "left": {
                closePeer(from);
                break;
            }
            default: /* ignore */
        }
    }

    public void closePeer(String peerId) {
        PeerConnection pc = peers.remove(peerId);
        peerNames.remove(peerId);
        if (pc != null) pc.close();
        if (listener != null) listener.onPeerGone(peerId);
    }

    public void closeAll() {
        for (String id : new ArrayList<>(peers.keySet())) closePeer(id);
        stopLocalCamera();
    }

    public void dispose() {
        closeAll();
        factory.dispose();
        eglBase.release();
    }

    private PeerConnection ensurePeer(String peerId, String name) {
        if (peers.containsKey(peerId)) return peers.get(peerId);
        if (peers.size() >= 3) return null; // 4 total minus self

        PeerConnection.RTCConfiguration rtc = new PeerConnection.RTCConfiguration(iceServers);
        rtc.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;

        PeerConnection pc = factory.createPeerConnection(rtc, new PeerConnection.Observer() {
            @Override public void onSignalingChange(PeerConnection.SignalingState state) {}
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) {
                if (state == PeerConnection.IceConnectionState.FAILED
                        || state == PeerConnection.IceConnectionState.CLOSED
                        || state == PeerConnection.IceConnectionState.DISCONNECTED) {
                    // Allow grace period; don't force-close on DISCONNECTED here.
                }
            }
            @Override public void onIceConnectionReceivingChange(boolean b) {}
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {}
            @Override public void onIceCandidate(IceCandidate candidate) {
                JSONObject c = new JSONObject();
                try {
                    c.put("candidate", candidate.sdp);
                    c.put("sdpMid", candidate.sdpMid);
                    c.put("sdpMLineIndex", candidate.sdpMLineIndex);
                } catch (JSONException ignored) {}
                JSONObject msg = new JSONObject();
                try { msg.put("candidate", c); } catch (JSONException ignored) {}
                sendSignal("rtc-ice", peerId, msg);
            }
            @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
            @Override public void onAddStream(MediaStream stream) {}
            @Override public void onRemoveStream(MediaStream stream) {}
            @Override public void onDataChannel(org.webrtc.DataChannel dc) {}
            @Override public void onRenegotiationNeeded() {}
            @Override public void onAddTrack(org.webrtc.RtpReceiver receiver, MediaStream[] streams) {
                MediaStreamTrack t = receiver.track();
                if (t instanceof VideoTrack && listener != null) {
                    listener.onRemoteTrack(peerId, peerNames.get(peerId), (VideoTrack) t);
                }
            }
        });
        if (pc == null) return null;

        // Attach local video track so the other side sees us too.
        if (localVideoTrack != null) {
            pc.addTransceiver(localVideoTrack, new RtpTransceiver.RtpTransceiverInit(
                    RtpTransceiver.RtpTransceiverDirection.SEND_RECV,
                    Collections.singletonList("RAVEN")));
        } else {
            // Recv-only if the camera isn't on yet.
            pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,
                    new RtpTransceiver.RtpTransceiverInit(
                            RtpTransceiver.RtpTransceiverDirection.RECV_ONLY,
                            Collections.singletonList("RAVEN")));
        }

        peers.put(peerId, pc);
        peerNames.put(peerId, name == null ? "" : name);
        return pc;
    }

    private void sendSignal(String type, String toPeerId, JSONObject payload) {
        try {
            JSONObject msg = new JSONObject();
            msg.put("type", type);
            msg.put("to", toPeerId);
            Iterator<String> keys = payload.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                msg.put(k, payload.get(k));
            }
            socket.send(msg);
        } catch (JSONException ignored) {}
    }

    private static JSONObject toJson(SessionDescription sdp) {
        JSONObject o = new JSONObject();
        try {
            JSONObject inner = new JSONObject();
            inner.put("type", sdp.type.canonicalForm());
            inner.put("sdp", sdp.description);
            o.put("sdp", inner);
        } catch (JSONException ignored) {}
        return o;
    }

    /** SdpObserver adapter. */
    private abstract static class SimpleSdp implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription sdp) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String s) { Log.w(TAG, "createSdp failed: " + s); }
        @Override public void onSetFailure(String s) { Log.w(TAG, "setSdp failed: " + s); }
    }
}
