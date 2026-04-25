package com.raven.app.ui;

import android.content.Intent;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;

import com.google.android.libraries.identity.googleid.GetGoogleIdOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import com.raven.app.BuildConfig;
import com.raven.app.R;
import com.raven.app.RavenApp;
import com.raven.app.databinding.ActivitySignInBinding;

/**
 * Google Sign-In using the modern Credential Manager API.
 * On success, we forward the Google ID token to Raven /raven/auth/google
 * which verifies it, upserts the user, and returns our session token.
 */
public class SignInActivity extends AppCompatActivity {

    private static final String TAG = "SignInActivity";

    // Hard cap on how long the Credential Manager flow may run. On non-Play-
    // certified emulators the call can spin forever (and ANR the system),
    // so we bail out and re-enable the buttons after this many ms.
    private static final long GOOGLE_SIGN_IN_TIMEOUT_MS = 25_000L;

    private ActivitySignInBinding binding;
    private CredentialManager credentialManager;
    private CancellationSignal googleSignInCancel;
    private final Handler timeoutHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivitySignInBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        // If already signed in, skip to dashboard.
        if (RavenApp.get(this).auth().isSignedIn()) {
            startActivity(new Intent(this, DashboardActivity.class));
            finish();
            return;
        }

        credentialManager = CredentialManager.create(this);
        binding.btnGoogle.setOnClickListener(v -> startGoogleSignIn());

        // Debug-only guest bypass for emulators that fail Play Protect.
        if (BuildConfig.DEBUG) {
            binding.btnGuest.setVisibility(android.view.View.VISIBLE);
            binding.btnGuest.setOnClickListener(v -> startGuestSignIn());
        }
    }

    private void startGuestSignIn() {
        binding.progress.setVisibility(android.view.View.VISIBLE);
        binding.btnGoogle.setEnabled(false);
        binding.btnGuest.setEnabled(false);
        RavenApp.get(this).api().signInAsGuest(null, (result, error) -> runOnUiThread(() -> {
            if (error != null || result == null || result.token == null || result.user == null) {
                Log.w(TAG, "guest sign-in failed", error);
                binding.btnGuest.setEnabled(true);
                String detail = error != null ? error.getMessage() : "no token returned";
                fail("Guest sign-in failed: " + detail);
                return;
            }
            RavenApp.get(this).auth().saveSession(
                    result.token,
                    result.user.id,
                    result.user.name,
                    result.user.email,
                    result.user.picture);
            startActivity(new Intent(this, DashboardActivity.class));
            finish();
        }));
    }

    private void startGoogleSignIn() {
        String clientId = BuildConfig.GOOGLE_WEB_CLIENT_ID;
        if (clientId == null || clientId.isEmpty()) {
            Toast.makeText(this, "GOOGLE_WEB_CLIENT_ID is not configured.", Toast.LENGTH_LONG).show();
            return;
        }
        binding.progress.setVisibility(android.view.View.VISIBLE);
        binding.btnGoogle.setEnabled(false);

        // setAutoSelectEnabled(false): on emulators without a Google account,
        // auto-select can hang waiting for a credential that will never arrive.
        GetGoogleIdOption option = new GetGoogleIdOption.Builder()
                .setFilterByAuthorizedAccounts(false)
                .setServerClientId(clientId)
                .setAutoSelectEnabled(false)
                .build();

        GetCredentialRequest request = new GetCredentialRequest.Builder()
                .addCredentialOption(option)
                .build();

        // Cancellable + timed: if Credential Manager doesn't respond within
        // GOOGLE_SIGN_IN_TIMEOUT_MS, cancel and surface a clear error so the
        // user can fall back to Guest (or use a Play-certified device).
        cancelPendingGoogleSignIn();
        googleSignInCancel = new CancellationSignal();
        final CancellationSignal thisCancel = googleSignInCancel;
        timeoutHandler.postDelayed(() -> {
            if (!thisCancel.isCanceled()) {
                thisCancel.cancel();
                fail("Google sign-in timed out. This emulator may not have Google Play Services. Try the Guest button or a Play-certified device.");
            }
        }, GOOGLE_SIGN_IN_TIMEOUT_MS);

        credentialManager.getCredentialAsync(
                this,
                request,
                googleSignInCancel,
                getMainExecutor(),
                new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                    @Override public void onResult(@NonNull GetCredentialResponse response) {
                        clearGoogleSignInTimeout();
                        handleCredential(response);
                    }
                    @Override public void onError(@NonNull GetCredentialException e) {
                        clearGoogleSignInTimeout();
                        Log.w(TAG, "getCredential failed", e);
                        binding.progress.setVisibility(android.view.View.GONE);
                        binding.btnGoogle.setEnabled(true);
                        String detail = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                        Toast.makeText(SignInActivity.this,
                                getString(R.string.sign_in_error) + ": " + detail,
                                Toast.LENGTH_LONG).show();
                    }
                });
    }

    private void clearGoogleSignInTimeout() {
        timeoutHandler.removeCallbacksAndMessages(null);
    }

    private void cancelPendingGoogleSignIn() {
        clearGoogleSignInTimeout();
        if (googleSignInCancel != null && !googleSignInCancel.isCanceled()) {
            googleSignInCancel.cancel();
        }
        googleSignInCancel = null;
    }

    @Override
    protected void onDestroy() {
        cancelPendingGoogleSignIn();
        super.onDestroy();
    }

    private void handleCredential(GetCredentialResponse response) {
        if (!(response.getCredential() instanceof CustomCredential)) {
            fail("No Google credential returned.");
            return;
        }
        CustomCredential cred = (CustomCredential) response.getCredential();
        if (!GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(cred.getType())) {
            fail("Unexpected credential type: " + cred.getType());
            return;
        }
        GoogleIdTokenCredential google = GoogleIdTokenCredential.createFrom(cred.getData());
        String idToken = google.getIdToken();

        RavenApp.get(this).api().signInWithGoogle(idToken, (result, error) -> runOnUiThread(() -> {
            if (error != null || result == null || result.token == null || result.user == null) {
                Log.w(TAG, "raven sign-in failed", error);
                String detail = error != null ? error.getMessage() : "no token returned";
                fail(getString(R.string.sign_in_error) + ": " + detail);
                return;
            }
            RavenApp.get(this).auth().saveSession(
                    result.token,
                    result.user.id,
                    result.user.name,
                    result.user.email,
                    result.user.picture);
            startActivity(new Intent(this, DashboardActivity.class));
            finish();
        }));
    }

    private void fail(String msg) {
        binding.progress.setVisibility(android.view.View.GONE);
        binding.btnGoogle.setEnabled(true);
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
    }
}
