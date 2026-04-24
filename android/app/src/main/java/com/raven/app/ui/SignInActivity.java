package com.raven.app.ui;

import android.content.Intent;
import android.os.Bundle;
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

    private ActivitySignInBinding binding;
    private CredentialManager credentialManager;

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
    }

    private void startGoogleSignIn() {
        String clientId = BuildConfig.GOOGLE_WEB_CLIENT_ID;
        if (clientId == null || clientId.isEmpty()) {
            Toast.makeText(this, "GOOGLE_WEB_CLIENT_ID is not configured.", Toast.LENGTH_LONG).show();
            return;
        }
        binding.progress.setVisibility(android.view.View.VISIBLE);
        binding.btnGoogle.setEnabled(false);

        GetGoogleIdOption option = new GetGoogleIdOption.Builder()
                .setFilterByAuthorizedAccounts(false)
                .setServerClientId(clientId)
                .setAutoSelectEnabled(true)
                .build();

        GetCredentialRequest request = new GetCredentialRequest.Builder()
                .addCredentialOption(option)
                .build();

        credentialManager.getCredentialAsync(
                this,
                request,
                null,
                getMainExecutor(),
                new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                    @Override public void onResult(@NonNull GetCredentialResponse response) {
                        handleCredential(response);
                    }
                    @Override public void onError(@NonNull GetCredentialException e) {
                        Log.w(TAG, "getCredential failed", e);
                        binding.progress.setVisibility(android.view.View.GONE);
                        binding.btnGoogle.setEnabled(true);
                        Toast.makeText(SignInActivity.this, R.string.sign_in_error, Toast.LENGTH_LONG).show();
                    }
                });
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
                fail(getString(R.string.sign_in_error));
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
