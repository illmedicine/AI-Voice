package com.raven.app.data.model;

public class ChatMessage {
    public String id;
    public long ts;
    public String role;      // "user" | "assistant"
    public String name;      // display name
    public String text;
    public String mood;      // assistant mood
    public String userId;    // sender userId (users only)
}
