package com.raven.app.ui;

import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.PopupMenu;
import android.widget.Toast;

import java.io.File;
import java.util.ArrayList;
import java.util.Locale;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.LinearLayoutManager;

import com.raven.app.R;
import com.raven.app.RavenApp;
import com.raven.app.data.model.ChatMessage;
import com.raven.app.databinding.ActivityChatBinding;
import com.raven.app.net.RealtimeSocket;
import com.raven.app.rtc.WebRtcManager;
import com.raven.app.ui.adapter.MessageAdapter;
import com.raven.app.ui.adapter.VideoTileAdapter;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.VideoTrack;

public class ChatActivity extends AppCompatActivity implements RealtimeSocket.Listener, WebRtcManager.Listener {

    public static final String EXTRA_CHAT_ID = "chat_id";
    public static final String EXTRA_CHAT_TITLE = "chat_title";

    private static final int REQ_PERMS = 42;
    private static final int REQ_MIC_PERM = 43;
    private static final String TAG = "ChatActivity";

    private ActivityChatBinding binding;
    private MessageAdapter messageAdapter;
    private VideoTileAdapter videoAdapter;

    private String chatId;
    private String chatTitle;

    private RealtimeSocket socket;
    private WebRtcManager webrtc;

    private boolean cameraOn;

    // ElevenLabs voice playback for Raven's replies (streams /raven/tts).
    private MediaPlayer ravenPlayer;
    private File ravenAudioFile;
    private boolean ravenSpeaking;

    // In-process speech recognizer for hands-free conversation (Grok-style).
    private SpeechRecognizer recognizer;
    private boolean recognizerListening;
    private boolean handsFreeMode;
    private boolean awaitingReply;
    private boolean activityStopped;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable resumeListenRunnable = this::resumeListeningIfNeeded;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!RavenApp.get(this).auth().isSignedIn()) {
            startActivity(new Intent(this, SignInActivity.class));
            finish();
            return;
        }

        binding = ActivityChatBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        chatId = getIntent().getStringExtra(EXTRA_CHAT_ID);
        chatTitle = getIntent().getStringExtra(EXTRA_CHAT_TITLE);
        if (chatId == null || chatId.isEmpty()) { finish(); return; }

        binding.titleText.setText(chatTitle == null || chatTitle.isEmpty() ? "Raven Chat" : chatTitle);
        binding.subtitleText.setText(chatId);

        // Messages
        messageAdapter = new MessageAdapter(new ArrayList<>(),
                RavenApp.get(this).auth().userId());
        LinearLayoutManager lm = new LinearLayoutManager(this);
        lm.setStackFromEnd(true);
        binding.messages.setLayoutManager(lm);
        binding.messages.setAdapter(messageAdapter);

        // Actions
        binding.btnBack.setOnClickListener(v -> finish());
        binding.btnShare.setOnClickListener(v -> shareChat());
        binding.btnMenu.setOnClickListener(this::showMenu);
        binding.btnSend.setOnClickListener(v -> sendCurrent());
        binding.input.setOnEditorActionListener((tv, id, ev) -> {
            if (id == EditorInfo.IME_ACTION_SEND) { sendCurrent(); return true; }
            return false;
        });
        binding.btnCamera.setOnClickListener(v -> toggleCamera());
        binding.btnMic.setOnClickListener(v -> toggleHandsFree());

        // Initialize WebRTC (factory created lazily by manager) + socket.
        socket = new RealtimeSocket(RavenApp.get(this).api().baseUrl());
        socket.setListener(this);
        webrtc = new WebRtcManager(this, socket);
        webrtc.setListener(this);

        videoAdapter = new VideoTileAdapter(webrtc.eglContext());
        GridLayoutManager grid = new GridLayoutManager(this, 2);
        grid.setSpanSizeLookup(videoAdapter.spanLookup(2));
        binding.videoGrid.setLayoutManager(grid);
        binding.videoGrid.setAdapter(videoAdapter);

        // Initialize on-device TTS. Uses the system engine — works on emulators
        // and avoids needing audio over WebRTC for the AI voice.
        // (TTS now uses ElevenLabs via /raven/tts — see speakRaven below.)

        loadHistory();
        connectSocket();
    }

    /** Strip a leading "[mood: X]" tag from Raven's reply before speaking it. */
    private static String stripMoodTag(String s) {
        if (s == null) return "";
        String t = s.trim();
        if (t.startsWith("[mood:")) {
            int end = t.indexOf(']');
            if (end > 0) return t.substring(end + 1).trim();
        }
        return s;
    }

    private void speakRaven(String text) {
        String clean = stripMoodTag(text);
        if (clean.isEmpty()) {
            // Nothing to say — but still resume listening if hands-free.
            scheduleResumeListening();
            return;
        }
        ravenSpeaking = true;
        // Make sure we're not capturing audio while Raven is talking, otherwise
        // the recognizer hears Raven and feeds it back into the conversation.
        stopListening();
        File out = new File(getCacheDir(), "raven-tts-" + System.currentTimeMillis() + ".mp3");
        // Hard-coded ElevenLabs voice ID for "Raven". Server falls back to its
        // configured default if this is null/empty, but we pin it here so the
        // client always gets the same voice regardless of server env.
        RavenApp.get(this).api().streamTts(clean, "CBCytkseYP5LYhTeh4Hd", out, (file, err) -> runOnUiThread(() -> {
            if (err != null || file == null) {
                Log.w(TAG, "raven tts fetch failed", err);
                ravenSpeaking = false;
                scheduleResumeListening();
                return;
            }
            playRavenAudio(file);
        }));
    }

    private void playRavenAudio(File file) {
        // Stop any previous playback and clean up its temp file.
        releaseRavenPlayer();
        ravenAudioFile = file;
        try {
            final MediaPlayer mp = new MediaPlayer();
            ravenPlayer = mp;
            mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            mp.setDataSource(file.getAbsolutePath());
            mp.setOnCompletionListener(p -> mainHandler.post(() -> {
                if (ravenPlayer == p) {
                    ravenSpeaking = false;
                    releaseRavenPlayer();
                    scheduleResumeListening();
                }
            }));
            mp.setOnErrorListener((p, what, extra) -> {
                Log.w(TAG, "MediaPlayer error what=" + what + " extra=" + extra);
                mainHandler.post(() -> {
                    if (ravenPlayer == p) {
                        ravenSpeaking = false;
                        releaseRavenPlayer();
                        scheduleResumeListening();
                    }
                });
                return true;
            });
            mp.setOnPreparedListener(p -> {
                if (activityStopped || ravenPlayer != p) return;
                try { p.start(); } catch (IllegalStateException ise) {
                    Log.w(TAG, "MediaPlayer.start failed", ise);
                    ravenSpeaking = false;
                    releaseRavenPlayer();
                    scheduleResumeListening();
                }
            });
            mp.prepareAsync();
        } catch (Exception e) {
            Log.w(TAG, "playRavenAudio failed", e);
            ravenSpeaking = false;
            releaseRavenPlayer();
            scheduleResumeListening();
        }
    }

    private void releaseRavenPlayer() {
        if (ravenPlayer != null) {
            MediaPlayer mp = ravenPlayer;
            ravenPlayer = null;
            try { mp.reset(); } catch (Exception ignored) {}
            try { mp.release(); } catch (Exception ignored) {}
        }
        if (ravenAudioFile != null) {
            try { ravenAudioFile.delete(); } catch (Exception ignored) {}
            ravenAudioFile = null;
        }
    }

    // ---------- Hands-free voice loop (Grok-style) ----------

    /** Mic button: toggle continuous listening. */
    private void toggleHandsFree() {
        if (handsFreeMode) {
            handsFreeMode = false;
            stopListening();
            mainHandler.removeCallbacks(resumeListenRunnable);
            updateMicVisual();
            Toast.makeText(this, R.string.chat_handsfree_off, Toast.LENGTH_SHORT).show();
            return;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC_PERM);
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            Toast.makeText(this, R.string.chat_voice_unavailable, Toast.LENGTH_LONG).show();
            return;
        }
        handsFreeMode = true;
        Toast.makeText(this, R.string.chat_handsfree_on, Toast.LENGTH_SHORT).show();
        updateMicVisual();
        scheduleResumeListening();
    }

    private void updateMicVisual() {
        binding.btnMic.setSelected(handsFreeMode);
        binding.btnMic.setContentDescription(
                getString(handsFreeMode ? R.string.chat_listening : R.string.chat_mic));
    }

    private void scheduleResumeListening() {
        mainHandler.removeCallbacks(resumeListenRunnable);
        // Brief delay so the mic doesn't pick up the tail of Raven's audio.
        mainHandler.postDelayed(resumeListenRunnable, 250);
    }

    private void resumeListeningIfNeeded() {
        if (!handsFreeMode || ravenSpeaking || awaitingReply || activityStopped) return;
        startListening();
    }

    private void ensureRecognizer() {
        if (recognizer != null) return;
        recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) {}
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() { recognizerListening = false; }
            @Override public void onPartialResults(Bundle partialResults) {}
            @Override public void onEvent(int eventType, Bundle params) {}

            @Override public void onError(int error) {
                recognizerListening = false;
                Log.d(TAG, "recognizer onError=" + error);
                // Common transient errors in hands-free: NO_MATCH, SPEECH_TIMEOUT,
                // RECOGNIZER_BUSY. Just resume listening shortly.
                if (handsFreeMode && !ravenSpeaking && !awaitingReply && !activityStopped) {
                    if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS
                            || error == SpeechRecognizer.ERROR_CLIENT) {
                        // Don't busy-loop on hard errors.
                        handsFreeMode = false;
                        updateMicVisual();
                        Toast.makeText(ChatActivity.this, R.string.chat_voice_unavailable,
                                Toast.LENGTH_LONG).show();
                        return;
                    }
                    mainHandler.postDelayed(resumeListenRunnable, 600);
                }
            }

            @Override public void onResults(Bundle results) {
                recognizerListening = false;
                ArrayList<String> matches = results.getStringArrayList(
                        SpeechRecognizer.RESULTS_RECOGNITION);
                if (matches == null || matches.isEmpty()) {
                    scheduleResumeListening();
                    return;
                }
                String spoken = matches.get(0);
                if (spoken == null || spoken.trim().isEmpty()) {
                    scheduleResumeListening();
                    return;
                }
                binding.input.setText(spoken);
                binding.input.setSelection(binding.input.getText().length());
                sendCurrent();
            }
        });
    }

    private void startListening() {
        if (recognizerListening || ravenSpeaking || awaitingReply || activityStopped) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ensureRecognizer();
        if (recognizer == null) return;
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault());
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 1500L);
        try {
            recognizer.startListening(intent);
            recognizerListening = true;
        } catch (Exception e) {
            Log.w(TAG, "startListening failed", e);
            recognizerListening = false;
            if (handsFreeMode) mainHandler.postDelayed(resumeListenRunnable, 800);
        }
    }

    private void stopListening() {
        if (recognizer == null) return;
        try { recognizer.cancel(); } catch (Exception ignored) {}
        recognizerListening = false;
    }

    private void releaseRecognizer() {
        if (recognizer != null) {
            try { recognizer.cancel(); } catch (Exception ignored) {}
            try { recognizer.destroy(); } catch (Exception ignored) {}
            recognizer = null;
        }
        recognizerListening = false;
    }

    private void loadHistory() {
        RavenApp.get(this).api().getChat(chatId, (detail, err) -> runOnUiThread(() -> {
            if (err != null) {
                Toast.makeText(this, "Couldn't load chat history.", Toast.LENGTH_SHORT).show();
                return;
            }
            if (detail == null) return;
            if (detail.title != null && !detail.title.isEmpty()) {
                chatTitle = detail.title;
                binding.titleText.setText(chatTitle);
            }
            int memberCount = detail.members == null ? 0 : detail.members.size();
            binding.subtitleText.setText(chatId + " · " + memberCount + "/4");
            if (detail.messages != null) {
                messageAdapter.replaceAll(detail.messages);
                scrollToBottom();
            }
        }));
    }

    private void connectSocket() {
        String token = RavenApp.get(this).auth().token();
        String name = RavenApp.get(this).auth().userName();
        socket.connect(token, chatId, name);
    }

    private void sendCurrent() {
        String text = binding.input.getText().toString().trim();
        if (text.isEmpty()) {
            scheduleResumeListening();
            return;
        }
        binding.input.setText("");
        // While waiting for Raven's reply, suspend the mic so we don't capture
        // ambient noise or the keyboard click.
        awaitingReply = true;
        stopListening();

        // Optimistic local echo (will be superseded by server-persisted copy on history reload).
        ChatMessage mine = new ChatMessage();
        mine.role = "user";
        mine.name = RavenApp.get(this).auth().userName();
        mine.userId = RavenApp.get(this).auth().userId();
        mine.text = text;
        mine.ts = System.currentTimeMillis();
        messageAdapter.add(mine);
        scrollToBottom();

        // Broadcast the user's line to other peers in real time.
        socket.sendChat(text);

        // Ask Raven for a reply (persisted server-side).
        String displayName = RavenApp.get(this).auth().userName();
        RavenApp.get(this).api().ask(chatId, text, displayName, (res, err) -> runOnUiThread(() -> {
            awaitingReply = false;
            if (err != null || res == null || res.assistant == null) {
                Toast.makeText(this, "Raven couldn't reply right now.", Toast.LENGTH_SHORT).show();
                scheduleResumeListening();
                return;
            }
            messageAdapter.add(res.assistant);
            scrollToBottom();
            speakRaven(res.assistant.text);
        }));
    }

    private void scrollToBottom() {
        int last = messageAdapter.lastIndex();
        if (last >= 0) binding.messages.smoothScrollToPosition(last);
    }

    private void shareChat() {
        String link = "https://raven.app/c/" + chatId;
        Intent share = new Intent(Intent.ACTION_SEND);
        share.setType("text/plain");
        share.putExtra(Intent.EXTRA_TEXT, "Join my Raven chat: " + link + "\nChat ID: " + chatId);
        startActivity(Intent.createChooser(share, getString(R.string.chat_share)));
    }

    private void showMenu(View anchor) {
        PopupMenu m = new PopupMenu(this, anchor);
        m.getMenu().add(0, 1, 0, R.string.chat_copy_id);
        m.getMenu().add(0, 2, 1, R.string.chat_leave);
        m.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case 1:
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Raven Chat ID", chatId));
                    Toast.makeText(this, R.string.chat_id_copied, Toast.LENGTH_SHORT).show();
                    return true;
                case 2:
                    RavenApp.get(this).api().leaveChat(chatId, null);
                    finish();
                    return true;
            }
            return false;
        });
        m.show();
    }

    // ---------- Camera ----------
    private void toggleCamera() {
        if (cameraOn) { stopCamera(); return; }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO},
                    REQ_PERMS);
            return;
        }
        startCamera();
    }

    private void startCamera() {
        VideoTrack local = webrtc.startLocalCamera();
        if (local == null) {
            Toast.makeText(this, "No camera available.", Toast.LENGTH_SHORT).show();
            return;
        }
        cameraOn = true;
        binding.btnCamera.setContentDescription(getString(R.string.chat_camera_off));
        binding.videoGrid.setVisibility(View.VISIBLE);
        videoAdapter.upsert("self", RavenApp.get(this).auth().userName() + " (you)", local);
        socket.sendCameraState(true);
    }

    private void stopCamera() {
        cameraOn = false;
        binding.btnCamera.setContentDescription(getString(R.string.chat_camera_on));
        socket.sendCameraState(false);
        videoAdapter.remove("self");
        if (videoAdapter.isEmpty()) binding.videoGrid.setVisibility(View.GONE);
        webrtc.stopLocalCamera();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERMS) {
            boolean granted = grantResults.length > 0;
            for (int g : grantResults) if (g != PackageManager.PERMISSION_GRANTED) granted = false;
            if (granted) startCamera();
            else Toast.makeText(this, R.string.permission_camera_denied, Toast.LENGTH_LONG).show();
        } else if (requestCode == REQ_MIC_PERM) {
            boolean granted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted) toggleHandsFree();
            else Toast.makeText(this, R.string.chat_voice_unavailable, Toast.LENGTH_SHORT).show();
        }
    }

    // ---------- Socket events (main thread) ----------
    @Override public void onOpen() { runOnUiThread(() -> {}); }

    @Override public void onClose(int code, String reason) {
        runOnUiThread(() -> {
            // Attempt a single quick reconnect on abnormal close.
            if (code != 1000) connectSocket();
        });
    }

    @Override public void onFailure(Throwable t) {
        runOnUiThread(() -> {
            // Silent retry
        });
    }

    @Override public void onMessage(JSONObject msg) {
        runOnUiThread(() -> handleSocketMessage(msg));
    }

    private void handleSocketMessage(JSONObject msg) {
        String type = msg.optString("type");
        switch (type) {
            case "welcome": {
                // If other members already have cameras on, initiate calls to them.
                JSONArray users = msg.optJSONArray("users");
                String selfPeerId = msg.optString("id");
                if (users != null) {
                    for (int i = 0; i < users.length(); i++) {
                        JSONObject u = users.optJSONObject(i);
                        if (u == null) continue;
                        String pid = u.optString("id");
                        if (pid.isEmpty() || pid.equals(selfPeerId)) continue;
                        if (u.optBoolean("hasCamera") && cameraOn) {
                            webrtc.startCall(pid, u.optString("name"));
                        }
                    }
                }
                break;
            }
            case "room-presence": {
                JSONArray users = msg.optJSONArray("users");
                int count = msg.optInt("count", users == null ? 0 : users.length());
                binding.subtitleText.setText(chatId + " · " + count + "/4");
                break;
            }
            case "chat": {
                ChatMessage m = new ChatMessage();
                m.role = "user";
                m.name = msg.optString("name");
                m.userId = msg.optString("userId");
                m.text = msg.optString("text");
                m.ts = System.currentTimeMillis();
                messageAdapter.add(m);
                scrollToBottom();
                break;
            }
            case "left": {
                String id = msg.optString("id");
                if (!id.isEmpty()) {
                    webrtc.closePeer(id);
                    videoAdapter.remove(id);
                    if (videoAdapter.isEmpty() && !cameraOn) binding.videoGrid.setVisibility(View.GONE);
                }
                break;
            }
            case "rtc-offer":
            case "rtc-answer":
            case "rtc-ice":
            case "rtc-close": {
                webrtc.onSignal(msg);
                break;
            }
            case "error": {
                String err = msg.optString("error");
                if ("full".equals(err)) Toast.makeText(this, R.string.chat_full, Toast.LENGTH_LONG).show();
                else if ("not_found".equals(err)) Toast.makeText(this, R.string.chat_not_found, Toast.LENGTH_LONG).show();
                break;
            }
            default: /* ignore */
        }
    }

    // ---------- WebRTC events ----------
    @Override public void onRemoteTrack(String peerId, String displayName, VideoTrack track) {
        runOnUiThread(() -> {
            binding.videoGrid.setVisibility(View.VISIBLE);
            videoAdapter.upsert(peerId, displayName, track);
        });
    }

    @Override public void onPeerGone(String peerId) {
        runOnUiThread(() -> {
            videoAdapter.remove(peerId);
            if (videoAdapter.isEmpty() && !cameraOn) binding.videoGrid.setVisibility(View.GONE);
        });
    }

    // ---------- Lifecycle ----------
    @Override
    protected void onStart() {
        super.onStart();
        activityStopped = false;
    }

    @Override
    protected void onStop() {
        activityStopped = true;
        // Don't hold the mic in the background.
        stopListening();
        mainHandler.removeCallbacks(resumeListenRunnable);
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacks(resumeListenRunnable);
        releaseRecognizer();
        releaseRavenPlayer();
        if (socket != null) socket.close();
        if (webrtc != null) webrtc.dispose();
        super.onDestroy();
    }
}
