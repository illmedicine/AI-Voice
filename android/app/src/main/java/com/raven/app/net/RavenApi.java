package com.raven.app.net;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.raven.app.data.AuthManager;
import com.raven.app.data.model.ChatMessage;
import com.raven.app.data.model.ChatSummary;
import com.raven.app.data.model.RavenUser;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Thin wrapper over the Raven HTTP API. All calls are asynchronous
 * and return results on an arbitrary background thread — callers must
 * post back to the main thread themselves.
 */
public class RavenApi {

    public interface Cb<T> {
        void onResult(@Nullable T value, @Nullable Throwable error);
    }

    private static final MediaType JSON = MediaType.parse("application/json; charset=utf-8");

    private final String baseUrl;
    private final AuthManager auth;
    private final OkHttpClient http;

    public RavenApi(String baseUrl, AuthManager auth) {
        this.baseUrl = trimRight(baseUrl);
        this.auth = auth;
        this.http = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build();
    }

    public String baseUrl() { return baseUrl; }

    private static String trimRight(String s) {
        if (s == null) return "";
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    private Request.Builder authed(Request.Builder b) {
        String t = auth.token();
        if (t != null && !t.isEmpty()) b.header("x-raven-token", t);
        return b;
    }

    // ---------- Auth ----------
    public void signInWithGoogle(String idToken, Cb<GoogleSignInResult> cb) {
        JSONObject body = new JSONObject();
        try { body.put("id_token", idToken); } catch (JSONException ignored) {}
        Request req = new Request.Builder()
                .url(baseUrl + "/raven/auth/google")
                .post(RequestBody.create(body.toString(), JSON))
                .build();
        http.newCall(req).enqueue(new Callback() {
            @Override public void onFailure(@NonNull Call call, @NonNull IOException e) { cb.onResult(null, e); }
            @Override public void onResponse(@NonNull Call call, @NonNull Response response) {
                try (Response r = response) {
                    String s = r.body() != null ? r.body().string() : "";
                    if (!r.isSuccessful()) { cb.onResult(null, new IOException("HTTP " + r.code() + ": " + s)); return; }
                    JSONObject o = new JSONObject(s);
                    GoogleSignInResult res = new GoogleSignInResult();
                    res.token = o.optString("token");
                    res.user = parseUser(o.optJSONObject("user"));
                    cb.onResult(res, null);
                } catch (Exception e) { cb.onResult(null, e); }
            }
        });
    }

    public static class GoogleSignInResult {
        public String token;
        public RavenUser user;
    }

    /**
     * Debug-only guest sign-in. Hits POST /raven/auth/dev which is
     * gated by RAVEN_DEV_MODE=1 on the server. Reuses GoogleSignInResult
     * since the response shape is identical: { token, user }.
     */
    public void signInAsGuest(@Nullable String name, Cb<GoogleSignInResult> cb) {
        JSONObject body = new JSONObject();
        try { if (name != null && !name.isEmpty()) body.put("name", name); } catch (JSONException ignored) {}
        Request req = new Request.Builder()
                .url(baseUrl + "/raven/auth/dev")
                .post(RequestBody.create(body.toString(), JSON))
                .build();
        http.newCall(req).enqueue(new Callback() {
            @Override public void onFailure(@NonNull Call call, @NonNull IOException e) { cb.onResult(null, e); }
            @Override public void onResponse(@NonNull Call call, @NonNull Response response) {
                try (Response r = response) {
                    String s = r.body() != null ? r.body().string() : "";
                    if (!r.isSuccessful()) { cb.onResult(null, new IOException("HTTP " + r.code() + ": " + s)); return; }
                    JSONObject o = new JSONObject(s);
                    GoogleSignInResult res = new GoogleSignInResult();
                    res.token = o.optString("token");
                    res.user = parseUser(o.optJSONObject("user"));
                    cb.onResult(res, null);
                } catch (Exception e) { cb.onResult(null, e); }
            }
        });
    }

    public void logout(Cb<Void> cb) {
        Request req = authed(new Request.Builder()
                .url(baseUrl + "/raven/auth/logout")
                .post(RequestBody.create("", JSON))).build();
        http.newCall(req).enqueue(simple(cb));
    }

    // ---------- Chats ----------
    public void listChats(Cb<List<ChatSummary>> cb) {
        Request req = authed(new Request.Builder().url(baseUrl + "/raven/chats").get()).build();
        http.newCall(req).enqueue(new Callback() {
            @Override public void onFailure(@NonNull Call call, @NonNull IOException e) { cb.onResult(null, e); }
            @Override public void onResponse(@NonNull Call call, @NonNull Response response) {
                try (Response r = response) {
                    String s = r.body() != null ? r.body().string() : "";
                    if (!r.isSuccessful()) { cb.onResult(null, new IOException("HTTP " + r.code() + ": " + s)); return; }
                    JSONArray arr = new JSONObject(s).optJSONArray("chats");
                    List<ChatSummary> out = new ArrayList<>();
                    if (arr != null) for (int i = 0; i < arr.length(); i++) out.add(parseSummary(arr.optJSONObject(i)));
                    cb.onResult(out, null);
                } catch (Exception e) { cb.onResult(null, e); }
            }
        });
    }

    public void createChat(String title, Cb<ChatSummary> cb) {
        JSONObject body = new JSONObject();
        try { body.put("title", title == null ? "New Raven Chat" : title); } catch (JSONException ignored) {}
        Request req = authed(new Request.Builder()
                .url(baseUrl + "/raven/chats")
                .post(RequestBody.create(body.toString(), JSON))).build();
        http.newCall(req).enqueue(new Callback() {
            @Override public void onFailure(@NonNull Call call, @NonNull IOException e) { cb.onResult(null, e); }
            @Override public void onResponse(@NonNull Call call, @NonNull Response response) {
                try (Response r = response) {
                    String s = r.body() != null ? r.body().string() : "";
                    if (!r.isSuccessful()) { cb.onResult(null, new IOException("HTTP " + r.code() + ": " + s)); return; }
                    JSONObject chat = new JSONObject(s).optJSONObject("chat");
                    cb.onResult(parseSummary(chat), null);
                } catch (Exception e) { cb.onResult(null, e); }
            }
        });
    }

    public void joinChat(String id, Cb<ChatSummary> cb) {
        Request req = authed(new Request.Builder()
                .url(baseUrl + "/raven/chats/" + id + "/join")
                .post(RequestBody.create("", JSON))).build();
        http.newCall(req).enqueue(new Callback() {
            @Override public void onFailure(@NonNull Call call, @NonNull IOException e) { cb.onResult(null, e); }
            @Override public void onResponse(@NonNull Call call, @NonNull Response response) {
                try (Response r = response) {
                    String s = r.body() != null ? r.body().string() : "";
                    if (!r.isSuccessful()) { cb.onResult(null, new IOException("HTTP " + r.code() + ": " + s)); return; }
                    JSONObject chat = new JSONObject(s).optJSONObject("chat");
                    cb.onResult(parseSummary(chat), null);
                } catch (Exception e) { cb.onResult(null, e); }
            }
        });
    }

    public void leaveChat(String id, Cb<Void> cb) {
        Request req = authed(new Request.Builder()
                .url(baseUrl + "/raven/chats/" + id + "/leave")
                .post(RequestBody.create("", JSON))).build();
        http.newCall(req).enqueue(simple(cb));
    }

    public void getChat(String id, Cb<ChatDetail> cb) {
        Request req = authed(new Request.Builder().url(baseUrl + "/raven/chats/" + id).get()).build();
        http.newCall(req).enqueue(new Callback() {
            @Override public void onFailure(@NonNull Call call, @NonNull IOException e) { cb.onResult(null, e); }
            @Override public void onResponse(@NonNull Call call, @NonNull Response response) {
                try (Response r = response) {
                    String s = r.body() != null ? r.body().string() : "";
                    if (!r.isSuccessful()) { cb.onResult(null, new IOException("HTTP " + r.code() + ": " + s)); return; }
                    JSONObject chat = new JSONObject(s).optJSONObject("chat");
                    cb.onResult(parseDetail(chat), null);
                } catch (Exception e) { cb.onResult(null, e); }
            }
        });
    }

    /** Ask Raven within a chat — records the user turn and returns Raven's reply. */
    public void ask(String chatId, String prompt, String displayName, Cb<AskResult> cb) {
        JSONObject body = new JSONObject();
        try {
            body.put("prompt", prompt);
            if (displayName != null) body.put("name", displayName);
        } catch (JSONException ignored) {}
        Request req = authed(new Request.Builder()
                .url(baseUrl + "/raven/chats/" + chatId + "/ask")
                .post(RequestBody.create(body.toString(), JSON))).build();
        http.newCall(req).enqueue(new Callback() {
            @Override public void onFailure(@NonNull Call call, @NonNull IOException e) { cb.onResult(null, e); }
            @Override public void onResponse(@NonNull Call call, @NonNull Response response) {
                try (Response r = response) {
                    String s = r.body() != null ? r.body().string() : "";
                    if (!r.isSuccessful()) { cb.onResult(null, new IOException("HTTP " + r.code() + ": " + s)); return; }
                    JSONObject o = new JSONObject(s);
                    AskResult ar = new AskResult();
                    ar.user = parseMessage(o.optJSONObject("user"));
                    ar.assistant = parseMessage(o.optJSONObject("assistant"));
                    cb.onResult(ar, null);
                } catch (Exception e) { cb.onResult(null, e); }
            }
        });
    }

    public static class AskResult {
        public ChatMessage user;
        public ChatMessage assistant;
    }

    public static class ChatDetail {
        public String id;
        public String title;
        public String ownerId;
        public List<String> members = new ArrayList<>();
        public List<ChatMessage> messages = new ArrayList<>();
    }

    // ---------- helpers ----------
    private static Callback simple(Cb<Void> cb) {
        return new Callback() {
            @Override public void onFailure(@NonNull Call call, @NonNull IOException e) { cb.onResult(null, e); }
            @Override public void onResponse(@NonNull Call call, @NonNull Response r) {
                try (Response resp = r) {
                    if (!resp.isSuccessful()) cb.onResult(null, new IOException("HTTP " + resp.code()));
                    else cb.onResult(null, null);
                }
            }
        };
    }

    private static RavenUser parseUser(@Nullable JSONObject o) {
        if (o == null) return null;
        RavenUser u = new RavenUser();
        u.id = o.optString("id");
        u.email = o.optString("email");
        u.name = o.optString("name");
        u.picture = o.optString("picture");
        return u;
    }

    private static ChatSummary parseSummary(@Nullable JSONObject o) {
        if (o == null) return null;
        ChatSummary c = new ChatSummary();
        c.id = o.optString("id");
        c.title = o.optString("title");
        c.ownerId = o.optString("ownerId");
        c.memberCount = o.optInt("memberCount", 1);
        c.maxMembers = o.optInt("maxMembers", 4);
        c.lastMessageAt = o.optLong("lastMessageAt", 0L);
        c.lastMessagePreview = o.optString("lastMessagePreview", "");
        return c;
    }

    private static ChatDetail parseDetail(@Nullable JSONObject o) {
        ChatDetail d = new ChatDetail();
        if (o == null) return d;
        d.id = o.optString("id");
        d.title = o.optString("title");
        d.ownerId = o.optString("ownerId");
        JSONArray m = o.optJSONArray("members");
        if (m != null) for (int i = 0; i < m.length(); i++) d.members.add(m.optString(i));
        JSONArray msgs = o.optJSONArray("messages");
        if (msgs != null) for (int i = 0; i < msgs.length(); i++) d.messages.add(parseMessage(msgs.optJSONObject(i)));
        return d;
    }

    private static ChatMessage parseMessage(@Nullable JSONObject o) {
        if (o == null) return null;
        ChatMessage m = new ChatMessage();
        m.id = o.optString("id");
        m.ts = o.optLong("ts", 0L);
        m.role = o.optString("role", "user");
        m.name = o.optString("name", "");
        m.text = o.optString("text", "");
        m.mood = o.optString("mood", "neutral");
        m.userId = o.optString("userId", "");
        return m;
    }
}
