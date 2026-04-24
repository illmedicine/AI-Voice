package com.raven.app;

import android.app.Application;

import com.raven.app.data.AuthManager;
import com.raven.app.net.RavenApi;

public class RavenApp extends Application {

    private AuthManager auth;
    private RavenApi api;

    @Override
    public void onCreate() {
        super.onCreate();
        auth = new AuthManager(this);
        api = new RavenApi(BuildConfig.RAVEN_BASE_URL, auth);
    }

    public static RavenApp get(android.content.Context ctx) {
        return (RavenApp) ctx.getApplicationContext();
    }

    public AuthManager auth() { return auth; }
    public RavenApi api() { return api; }
}
