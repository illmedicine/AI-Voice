package com.raven.app.ui.adapter;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.raven.app.R;

import org.webrtc.EglBase;
import org.webrtc.RendererCommon;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoTrack;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Grid of camera tiles (up to 4). Supports a local "self" tile plus
 * remote peers keyed by peerId.
 */
public class VideoTileAdapter extends RecyclerView.Adapter<VideoTileAdapter.VH> {

    public static class Tile {
        public final String key;          // "self" or peerId
        public String name;
        @Nullable public VideoTrack track;
        public Tile(String key, String name, @Nullable VideoTrack track) {
            this.key = key; this.name = name; this.track = track;
        }
    }

    private final EglBase.Context eglContext;
    private final Map<String, Tile> tiles = new LinkedHashMap<>();
    private final List<String> order = new ArrayList<>();

    public VideoTileAdapter(EglBase.Context eglContext) {
        this.eglContext = eglContext;
    }

    public void upsert(String key, String name, @Nullable VideoTrack track) {
        Tile existing = tiles.get(key);
        if (existing == null) {
            Tile t = new Tile(key, name, track);
            tiles.put(key, t);
            order.add(key);
            notifyItemInserted(order.size() - 1);
        } else {
            existing.name = name != null ? name : existing.name;
            existing.track = track != null ? track : existing.track;
            int idx = order.indexOf(key);
            if (idx >= 0) notifyItemChanged(idx);
        }
    }

    public void remove(String key) {
        int idx = order.indexOf(key);
        if (idx < 0) return;
        order.remove(idx);
        tiles.remove(key);
        notifyItemRemoved(idx);
    }

    public boolean isEmpty() { return order.isEmpty(); }

    public GridLayoutManager.SpanSizeLookup spanLookup(int spanCount) {
        return new GridLayoutManager.SpanSizeLookup() {
            @Override public int getSpanSize(int position) {
                int n = order.size();
                if (n == 1) return spanCount;
                if (n == 3 && position == 0) return spanCount;
                return 1;
            }
        };
    }

    @NonNull @Override
    public VH onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View v = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_video_tile, parent, false);
        return new VH(v, eglContext);
    }

    @Override
    public void onBindViewHolder(@NonNull VH h, int position) {
        Tile t = tiles.get(order.get(position));
        if (t == null) return;
        h.label.setText(t.name == null ? "" : t.name);
        h.attach(t.track);
    }

    @Override
    public void onViewRecycled(@NonNull VH h) {
        h.detach();
    }

    @Override public int getItemCount() { return order.size(); }

    static class VH extends RecyclerView.ViewHolder {
        final FrameLayout container;
        final TextView label;
        final SurfaceViewRenderer renderer;
        @Nullable VideoTrack attached;

        VH(@NonNull View v, EglBase.Context eglCtx) {
            super(v);
            container = v.findViewById(R.id.videoContainer);
            label = v.findViewById(R.id.nameLabel);
            renderer = new SurfaceViewRenderer(v.getContext());
            renderer.init(eglCtx, null);
            renderer.setEnableHardwareScaler(true);
            renderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL);
            container.addView(renderer, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));
        }

        void attach(@Nullable VideoTrack t) {
            if (attached == t) return;
            detach();
            if (t != null) {
                t.addSink(renderer);
                attached = t;
            }
        }

        void detach() {
            if (attached != null) {
                try { attached.removeSink(renderer); } catch (Throwable ignored) {}
                attached = null;
            }
        }
    }
}
