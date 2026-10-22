package com.cooktrace.app;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * This install's id, kept where backups never go (res/xml/backup_rules.xml
 * and data_extraction_rules.xml leave out this one preferences file). The
 * app's database is backed up, and comes back on a new phone, or a second
 * one, with the install id inside it. The app compares the two
 * (src/lib/db-native.js dbInstallId): when they differ, the database came
 * from somewhere else and this install takes a new id, so two phones never
 * send the server the same key for different rows.
 */
@CapacitorPlugin(name = "InstallMarker")
public class InstallMarkerPlugin extends Plugin {
    static final String FILE = "ct_install_marker";
    private static final String KEY = "install_id";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void get(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("value", prefs().getString(KEY, null));
        call.resolve(ret);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String value = call.getString("value");
        boolean ok = prefs().edit().putString(KEY, value).commit();
        if (ok) call.resolve(); else call.reject("could not keep the install id");
    }
}
