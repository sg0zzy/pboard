package it.stefanogozzi.pboard;

import android.app.Activity;
import android.accounts.Account;
import android.content.Context;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.ClearTokenRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;
import java.util.Arrays;
import java.util.List;

/** Native Google authorization: no embedded browser, redirect URI or client secret. */
@CapacitorPlugin(name = "GoogleDriveAuth")
public class GoogleDriveAuthPlugin extends Plugin {
    private static final List<Scope> SCOPES = Arrays.asList(
        new Scope("https://www.googleapis.com/auth/drive.appdata"),
        new Scope("https://www.googleapis.com/auth/drive")
    );
    private ActivityResultLauncher<IntentSenderRequest> authorization;
    private volatile PluginCall pending;
    private String accessToken;

    @Override
    public void load() {
        authorization = bridge.registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), result -> {
            PluginCall call = pending;
            if (call == null) return;
            if (result.getResultCode() != Activity.RESULT_OK) {
                fail(call, "Google Drive authorization was cancelled.", null);
                return;
            }
            try {
                finish(call, Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(result.getData()));
            } catch (Exception error) {
                fail(call, "Google Drive authorization failed.", error);
            }
        });
    }

    @PluginMethod
    public void authorize(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (pending != null) { call.reject("Google authorization is already in progress."); return; }
            pending = call;
            if (Boolean.TRUE.equals(call.getBoolean("forceRefresh", false)) && accessToken != null) {
                Identity.getAuthorizationClient(getActivity())
                    .clearToken(ClearTokenRequest.builder().setToken(accessToken).build())
                    .addOnSuccessListener(unused -> request(call))
                    .addOnFailureListener(error -> fail(call, "Could not refresh Google authorization.", error));
            } else request(call);
        });
    }

    private void request(PluginCall call) {
        AuthorizationRequest.Builder builder = AuthorizationRequest.builder().setRequestedScopes(SCOPES);
        String email = getContext().getSharedPreferences("pboard-drive", Context.MODE_PRIVATE).getString("account", null);
        if (email != null) builder.setAccount(new Account(email, "com.google"));
        AuthorizationRequest request = builder.build();
        Identity.getAuthorizationClient(getActivity()).authorize(request)
            .addOnSuccessListener(result -> {
                if (pending != call) return;
                if (result.hasResolution()) {
                    if (!Boolean.TRUE.equals(call.getBoolean("interactive", false))) {
                        fail(call, "Google Drive needs authorization. Tap Reconnect in Settings.", null);
                        return;
                    }
                    if (result.getPendingIntent() == null) { fail(call, "Google authorization could not start.", null); return; }
                    authorization.launch(new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build());
                } else finish(call, result);
            })
            .addOnFailureListener(error -> fail(call, "Google Drive authorization failed. Check the Android OAuth client package and signing SHA-1 in Google Cloud.", error));
    }

    private void finish(PluginCall call, AuthorizationResult result) {
        if (pending != call) return;
        if (!result.getGrantedScopes().containsAll(Arrays.asList(
            "https://www.googleapis.com/auth/drive.appdata", "https://www.googleapis.com/auth/drive"))) {
            fail(call, "Both Drive permissions are required for sync and collaboration.", null);
            return;
        }
        accessToken = result.getAccessToken();
        if (accessToken == null) { fail(call, "Google did not return an access token.", null); return; }
        final String token = accessToken;
        // Pin the selected Drive account across token renewal and app restarts.
        // Only its email is persisted; access tokens stay in memory/GIS's cache.
        bridge.execute(() -> {
            try {
                var preferences = getContext().getSharedPreferences("pboard-drive", Context.MODE_PRIVATE);
                if (!preferences.contains("account")) {
                    HttpURLConnection connection = (HttpURLConnection) new URL("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)").openConnection();
                    try {
                        connection.setConnectTimeout(15000);
                        connection.setReadTimeout(15000);
                        connection.setRequestProperty("Authorization", "Bearer " + token);
                        if (connection.getResponseCode() != 200) throw new IllegalStateException("Could not identify the Google Drive account.");
                        String body;
                        try (var stream = connection.getInputStream()) { body = new String(stream.readAllBytes(), StandardCharsets.UTF_8); }
                        String email = new JSONObject(body).getJSONObject("user").getString("emailAddress");
                        if (email.isBlank()) throw new IllegalStateException("Google Drive returned an empty account.");
                        if (pending != call) return;
                        preferences.edit().putString("account", email).apply();
                    } finally { connection.disconnect(); }
                }
                if (pending != call) return;
                pending = null;
                JSObject response = new JSObject();
                response.put("accessToken", token);
                call.resolve(response);
            } catch (Exception error) { fail(call, "Could not identify the Google Drive account. Try connecting again.", error); }
        });
    }

    private void fail(PluginCall call, String message, Exception error) {
        if (pending != call) return;
        pending = null;
        if (error == null) call.reject(message); else call.reject(message, error);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (pending != null) { PluginCall old = pending; pending = null; old.reject("Google Drive was disconnected."); }
            // Disconnect locally; revoking the project grant would also affect Firefox.
            String previous = accessToken;
            accessToken = null;
            if (previous == null) { call.resolve(); return; }
            Identity.getAuthorizationClient(getActivity()).clearToken(ClearTokenRequest.builder().setToken(previous).build())
                .addOnSuccessListener(unused -> call.resolve())
                .addOnFailureListener(error -> call.reject("Disconnected locally, but the token cache could not be cleared.", error));
        });
    }
}
