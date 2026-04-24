package com.raven.app.net;

import androidx.annotation.Nullable;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * WebSocket client for /rt. Handles chat broadcasts, presence, and
 * passes WebRTC signaling to the attached {@link Listener}.
 */
public class RealtimeSocket {

    public interface Listener {
        void onOpen();
        void onClose(int code, String reason);
        void onFailure(Throwable t);
        void onMessage(JSONObject msg);
    }

    private final OkHttpClient client;
    private final String wsBaseUrl;
    private WebSocket socket;
    private Listener listener;

    public RealtimeSocket(String httpBaseUrl) {
        // Convert https://host -> wss://host, http -> ws.
        String base = httpBaseUrl;
        if (base.startsWith("https://")) base = "wss://" + base.substring("https://".length());
        else if (base.startsWith("http://")) base = "ws://" + base.substring("http://".length());
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        this.wsBaseUrl = base;

        this.client = new OkHttpClient.Builder()
                .pingInterval(20, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .build();
    }

    public void setListener(Listener l) { this.listener = l; }

    public void connect(String ravenToken, String roomId, String displayName) {
        StringBuilder q = new StringBuilder(wsBaseUrl).append("/rt?raven=").append(enc(ravenToken));
        if (roomId != null && !roomId.isEmpty()) q.append("&room=").append(enc(roomId));
        if (displayName != null && !displayName.isEmpty()) q.append("&name=").append(enc(displayName));
        Request req = new Request.Builder().url(q.toString()).build();
        socket = client.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response r) { if (listener != null) listener.onOpen(); }
            @Override public void onMessage(WebSocket ws, String text) {
                if (listener == null) return;
                try { listener.onMessage(new JSONObject(text)); } catch (JSONException ignored) {}
            }
            @Override public void onMessage(WebSocket ws, ByteString bytes) { /* unused */ }
            @Override public void onClosed(WebSocket ws, int code, String reason) { if (listener != null) listener.onClose(code, reason); }
            @Override public void onFailure(WebSocket ws, Throwable t, @Nullable Response r) { if (listener != null) listener.onFailure(t); }
        });
    }

    public void send(JSONObject obj) {
        if (socket != null) socket.send(obj.toString());
    }

    public void sendChat(String text) {
        try { send(new JSONObject().put("type", "chat").put("text", text)); } catch (JSONException ignored) {}
    }

    public void sendCameraState(boolean on) {
        try { send(new JSONObject().put("type", "camera").put("on", on)); } catch (JSONException ignored) {}
    }

    public void close() {
        if (socket != null) {
            socket.close(1000, "bye");
            socket = null;
        }
    }

    private static String enc(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '_' || c == '.' || c == '~') b.append(c);
            else { b.append('%'); b.append(String.format("%02X", (int) c)); }
        }
        return b.toString();
    }
}
