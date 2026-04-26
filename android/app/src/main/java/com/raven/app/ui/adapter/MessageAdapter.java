package com.raven.app.ui.adapter;

import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.raven.app.R;
import com.raven.app.data.model.ChatMessage;

import java.util.List;

public class MessageAdapter extends RecyclerView.Adapter<MessageAdapter.VH> {

    private final List<ChatMessage> items;
    private final String selfUserId;

    public MessageAdapter(List<ChatMessage> items, String selfUserId) {
        this.items = items;
        this.selfUserId = selfUserId == null ? "" : selfUserId;
    }

    public void add(ChatMessage m) {
        items.add(m);
        notifyItemInserted(items.size() - 1);
    }

    public void replaceAll(List<ChatMessage> next) {
        items.clear();
        if (next != null) {
            for (ChatMessage m : next) if (m != null) items.add(m);
        }
        notifyDataSetChanged();
    }

    public int lastIndex() { return items.size() - 1; }

    @NonNull @Override
    public VH onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View v = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_message, parent, false);
        return new VH(v);
    }

    @Override
    public void onBindViewHolder(@NonNull VH h, int position) {
        ChatMessage m = items.get(position);

        boolean assistant = "assistant".equals(m.role);
        boolean self = !assistant && selfUserId.equals(m.userId);

        // The item root is a LinearLayout (see item_message.xml). Its layout params
        // come from the RecyclerView (RecyclerView.LayoutParams) — do NOT cast them
        // to LinearLayout.LayoutParams or you'll get a ClassCastException.
        LinearLayout row = (LinearLayout) h.itemView;
        row.setGravity(self ? Gravity.END : Gravity.START);

        h.sender.setText(assistant ? "Raven" : (m.name == null || m.name.isEmpty() ? "User" : m.name));
        h.bubble.setText(stripMoodTag(m.text));

        int bg = assistant ? R.drawable.bg_bubble_ai
                : self ? R.drawable.bg_bubble_user : R.drawable.bg_bubble_peer;
        h.bubble.setBackgroundResource(bg);

        // Align bubble + sender label to the correct side within the LinearLayout row.
        LinearLayout.LayoutParams ll = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ll.gravity = self ? Gravity.END : Gravity.START;
        h.bubble.setLayoutParams(ll);
        h.sender.setLayoutParams(ll);
    }

    /** Raven's replies sometimes start with "[mood: happy]" — hide that from the UI. */
    private static String stripMoodTag(String s) {
        if (s == null) return "";
        String t = s.trim();
        if (t.startsWith("[mood:")) {
            int end = t.indexOf(']');
            if (end > 0) return t.substring(end + 1).trim();
        }
        return s;
    }

    @Override public int getItemCount() { return items.size(); }

    static class VH extends RecyclerView.ViewHolder {
        final TextView sender, bubble;
        VH(@NonNull View v) {
            super(v);
            sender = v.findViewById(R.id.senderName);
            bubble = v.findViewById(R.id.bubble);
        }
    }
}
