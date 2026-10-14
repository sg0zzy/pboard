package it.stefanogozzi.pboard;

import android.app.Activity;
import android.content.Intent;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;

/** Save a completed ZIP to a user-selected document, without storage permissions. */
@CapacitorPlugin(name = "BoardExport")
public class BoardExportPlugin extends Plugin {
    @PluginMethod
    public void save(PluginCall call) {
        String filename = call.getString("filename");
        if (filename == null || call.getString("data") == null) {
            call.reject("Missing board archive");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/zip");
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        startActivityForResult(call, intent, "documentChosen");
    }

    @ActivityCallback
    private void documentChosen(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            JSObject response = new JSObject(); response.put("saved", false); call.resolve(response);
            return;
        }
        bridge.execute(() -> {
            try (OutputStream output = getContext().getContentResolver().openOutputStream(result.getData().getData(), "wt")) {
                if (output == null) throw new IllegalStateException("Destination could not be opened");
                output.write(Base64.decode(call.getString("data"), Base64.DEFAULT));
                JSObject response = new JSObject(); response.put("saved", true); call.resolve(response);
            } catch (Exception error) {
                call.reject("The board archive could not be saved", error);
            }
        });
    }
}
