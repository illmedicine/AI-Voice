package com.raven.app.ui.adapter;

import android.text.format.DateUtils;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.raven.app.R;
import com.raven.app.data.model.ChatSummary;

import java.util.List;

public class ChatListAdapter extends RecyclerView.Adapter<ChatListAdapter.VH> {

    public interface OnClick { void onClick(ChatSummary s); }

    private List<ChatSummary> items;
    private final OnClick onClick;

    public ChatListAdapter(List<ChatSummary> items, OnClick onClick) {
        this.items = items;
        this.onClick = onClick;
    }

    public void replace(List<ChatSummary> next) {
        this.items = next;
        notifyDataSetChanged();
    }

    @NonNull @Override
    public VH onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View v = LayoutInflater.from(parent.getContext())
                .inflate(R.layout.item_chat_summary, parent, false);
        return new VH(v);
    }

    @Override
    public void onBindViewHolder(@NonNull VH h, int position) {
        ChatSummary s = items.get(position);
        h.title.setText(s.title == null || s.title.isEmpty() ? "Untitled" : s.title);
        h.chatId.setText(s.id);
        h.badge.setText(s.memberCount + "/" + (s.maxMembers == 0 ? 4 : s.maxMembers));
        h.preview.setText(s.lastMessagePreview == null ? "" : s.lastMessagePreview);
        h.ts.setText(s.lastMessageAt > 0
                ? DateUtils.getRelativeTimeSpanString(s.lastMessageAt)
                : "");
        h.itemView.setOnClickListener(v -> onClick.onClick(s));
    }

    @Override public int getItemCount() { return items == null ? 0 : items.size(); }

    static class VH extends RecyclerView.ViewHolder {
        final TextView title, preview, chatId, badge, ts;
        VH(@NonNull View v) {
            super(v);
            title = v.findViewById(R.id.title);
            preview = v.findViewById(R.id.preview);
            chatId = v.findViewById(R.id.chatIdText);
            badge = v.findViewById(R.id.memberBadge);
            ts = v.findViewById(R.id.timestamp);
        }
    }
}
