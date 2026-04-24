package com.raven.app.ui;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.recyclerview.widget.LinearLayoutManager;

import coil.Coil;
import coil.request.ImageRequest;
import com.raven.app.R;
import com.raven.app.RavenApp;
import com.raven.app.data.model.ChatSummary;
import com.raven.app.databinding.ActivityDashboardBinding;
import com.raven.app.ui.adapter.ChatListAdapter;

import java.util.ArrayList;

/**
 * Home screen: user profile, New Chat button, Join by ID input,
 * and a Grok-like list of past chats.
 *
 * Supports deep links:
 *   raven://chat?id=ABCD1234
 *   https://raven.app/c/ABCD1234
 */
public class DashboardActivity extends AppCompatActivity {

    private ActivityDashboardBinding binding;
    private ChatListAdapter adapter;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!RavenApp.get(this).auth().isSignedIn()) {
            startActivity(new Intent(this, SignInActivity.class));
            finish();
            return;
        }

        binding = ActivityDashboardBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        bindHeader();
        setupList();
        setupActions();
        handleDeepLink(getIntent());
        refresh();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleDeepLink(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    private void bindHeader() {
        String name = RavenApp.get(this).auth().userName();
        String pic = RavenApp.get(this).auth().userPicture();
        binding.userName.setText(TextUtils.isEmpty(name) ? "Raven" : name);
        if (!TextUtils.isEmpty(pic)) {
            Coil.imageLoader(this).enqueue(new ImageRequest.Builder(this)
                    .data(pic)
                    .target(binding.avatar)
                    .build());
        }
    }

    private void setupList() {
        adapter = new ChatListAdapter(new ArrayList<>(), summary -> openChat(summary.id, summary.title));
        binding.chatList.setLayoutManager(new LinearLayoutManager(this));
        binding.chatList.setAdapter(adapter);

        binding.swipe.setOnRefreshListener(this::refresh);
    }

    private void setupActions() {
        binding.btnNewChat.setOnClickListener(v -> {
            binding.btnNewChat.setEnabled(false);
            RavenApp.get(this).api().createChat("New Raven Chat", (chat, err) -> runOnUiThread(() -> {
                binding.btnNewChat.setEnabled(true);
                if (err != null || chat == null) {
                    Toast.makeText(this, "Couldn't create chat.", Toast.LENGTH_SHORT).show();
                    return;
                }
                openChat(chat.id, chat.title);
            }));
        });

        binding.btnJoin.setOnClickListener(v -> {
            String id = binding.chatIdInput.getText().toString().trim().toUpperCase();
            if (id.isEmpty()) return;
            binding.btnJoin.setEnabled(false);
            RavenApp.get(this).api().joinChat(id, (chat, err) -> runOnUiThread(() -> {
                binding.btnJoin.setEnabled(true);
                if (err != null || chat == null) {
                    String msg = err != null && err.getMessage() != null && err.getMessage().contains("409")
                            ? getString(R.string.chat_full)
                            : getString(R.string.chat_not_found);
                    Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
                    return;
                }
                binding.chatIdInput.setText("");
                openChat(chat.id, chat.title);
            }));
        });

        binding.btnSignOut.setOnClickListener(v -> {
            RavenApp.get(this).api().logout(null);
            RavenApp.get(this).auth().clear();
            startActivity(new Intent(this, SignInActivity.class));
            finish();
        });
    }

    private void handleDeepLink(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null) return;
        String id = null;
        if ("raven".equals(data.getScheme())) id = data.getQueryParameter("id");
        else if (data.getPath() != null && data.getPath().startsWith("/c/")) id = data.getPath().substring(3);
        if (id != null && !id.isEmpty()) {
            final String target = id.toUpperCase();
            RavenApp.get(this).api().joinChat(target, (chat, err) -> runOnUiThread(() -> {
                if (chat != null) openChat(chat.id, chat.title);
                else Toast.makeText(this, R.string.chat_not_found, Toast.LENGTH_SHORT).show();
            }));
        }
    }

    private void refresh() {
        binding.swipe.setRefreshing(true);
        RavenApp.get(this).api().listChats((chats, err) -> runOnUiThread(() -> {
            binding.swipe.setRefreshing(false);
            if (err != null) {
                Toast.makeText(this, "Couldn't load chats.", Toast.LENGTH_SHORT).show();
                return;
            }
            adapter.replace(chats == null ? new ArrayList<>() : chats);
            binding.emptyState.setVisibility(
                    chats == null || chats.isEmpty() ? View.VISIBLE : View.GONE);
        }));
    }

    private void openChat(String id, String title) {
        Intent i = new Intent(this, ChatActivity.class);
        i.putExtra(ChatActivity.EXTRA_CHAT_ID, id);
        i.putExtra(ChatActivity.EXTRA_CHAT_TITLE, title);
        startActivity(i);
    }
}
