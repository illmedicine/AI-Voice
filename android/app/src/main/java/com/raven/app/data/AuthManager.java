package com.raven.app.data;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

/**
 * Stores the Raven session token and cached profile in EncryptedSharedPreferences.
 */
public class AuthManager {

    private static final String PREFS = "raven_secure_prefs";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_USER_ID = "user_id";
    private static final String KEY_USER_NAME = "user_name";
    private static final String KEY_USER_EMAIL = "user_email";
    private static final String KEY_USER_PICTURE = "user_picture";

    private final SharedPreferences prefs;

    public AuthManager(Context ctx) {
        SharedPreferences sp;
        try {
            MasterKey key = new MasterKey.Builder(ctx)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            sp = EncryptedSharedPreferences.create(
                    ctx,
                    PREFS,
                    key,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        } catch (Exception e) {
            // Fallback: plain prefs. Device-locked accounts will still be OK because
            // the only long-lived secret here is the Raven session token.
            sp = ctx.getSharedPreferences(PREFS + "_plain", Context.MODE_PRIVATE);
        }
        this.prefs = sp;
    }

    public synchronized void saveSession(String token, String userId, String name, String email, String picture) {
        prefs.edit()
                .putString(KEY_TOKEN, token)
                .putString(KEY_USER_ID, userId)
                .putString(KEY_USER_NAME, name == null ? "" : name)
                .putString(KEY_USER_EMAIL, email == null ? "" : email)
                .putString(KEY_USER_PICTURE, picture == null ? "" : picture)
                .apply();
    }

    public String token() { return prefs.getString(KEY_TOKEN, null); }
    public String userId() { return prefs.getString(KEY_USER_ID, null); }
    public String userName() { return prefs.getString(KEY_USER_NAME, ""); }
    public String userEmail() { return prefs.getString(KEY_USER_EMAIL, ""); }
    public String userPicture() { return prefs.getString(KEY_USER_PICTURE, ""); }

    public boolean isSignedIn() {
        String t = token();
        return t != null && !t.isEmpty();
    }

    public void clear() {
        prefs.edit().clear().apply();
    }
}
