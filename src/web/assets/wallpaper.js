// Custom frosted-grid backdrop wallpaper uploader and interactive aspect-ratio cropper.
window.initWallpaperControls = function initWallpaperControls({ state, $, LS, api }) {
  // ---- Optional Wallpaper Behind Frosted Grid (+ Interactive Cropper) ----
  const wpCrop = {
    open: false,
    srcDataUrl: '',
    mime: '',
    natW: 0,
    natH: 0,
    ratioMode: 'screen',
    rect: { x: 0, y: 0, w: 1, h: 1 }, // normalized [0..1]
    drag: null,
  };

  function getTargetAspect(mode) {
    if (mode === 'screen') return Math.max(0.35, Math.min(3.5, window.innerWidth / Math.max(1, window.innerHeight)));
    if (mode === '16:9') return 16 / 9;
    if (mode === '16:10') return 16 / 10;
    if (mode === '4:3') return 4 / 3;
    if (mode === '9:16') return 9 / 16;
    return null; // free / full
  }

  function fitCropRect(aspect, cx = 0.5, cy = 0.5) {
    if (!aspect || !wpCrop.natW || !wpCrop.natH) return { x: 0, y: 0, w: 1, h: 1 };
    const imgAspect = wpCrop.natW / wpCrop.natH;
    let w, h;
    if (aspect >= imgAspect) {
      w = 1;
      h = imgAspect / aspect;
    } else {
      h = 1;
      w = aspect / imgAspect;
    }
    const x = Math.max(0, Math.min(1 - w, cx - w / 2));
    const y = Math.max(0, Math.min(1 - h, cy - h / 2));
    return { x, y, w, h };
  }

  function renderCropBox() {
    const box = $('wpCropBox');
    const { x, y, w, h } = wpCrop.rect;
    box.style.left = `${(x * 100).toFixed(4)}%`;
    box.style.top = `${(y * 100).toFixed(4)}%`;
    box.style.width = `${(w * 100).toFixed(4)}%`;
    box.style.height = `${(h * 100).toFixed(4)}%`;
    const pw = Math.max(1, Math.round(w * wpCrop.natW));
    const ph = Math.max(1, Math.round(h * wpCrop.natH));
    $('wpCropDims').textContent = `${pw} × ${ph} px`;
  }

  function setCropRatio(mode) {
    wpCrop.ratioMode = mode;
    document.querySelectorAll('#wpRatioGroup .wp-ratio-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.ratio === mode);
    });
    if (mode === 'full') {
      wpCrop.rect = { x: 0, y: 0, w: 1, h: 1 };
    } else if (mode !== 'free') {
      const cx = wpCrop.rect.x + wpCrop.rect.w / 2;
      const cy = wpCrop.rect.y + wpCrop.rect.h / 2;
      wpCrop.rect = fitCropRect(getTargetAspect(mode), cx, cy);
    }
    renderCropBox();
  }

  function closeCropMode() {
    wpCrop.open = false;
    wpCrop.drag = null;
    $('wpCropPane').classList.remove('open');
    $('wpNormalPane').style.display = '';
  }

  function openCropMode(srcUrl, mime = '') {
    const img = $('wpCropImg');
    img.onload = () => {
      wpCrop.natW = img.naturalWidth || 1;
      wpCrop.natH = img.naturalHeight || 1;
      wpCrop.srcDataUrl = srcUrl;
      wpCrop.mime = mime;
      wpCrop.open = true;
      $('wpNormalPane').style.display = 'none';
      $('wpCropPane').classList.add('open');
      setCropRatio('screen');
    };
    img.onerror = () => alert('加载图片失败');
    img.src = srcUrl;
  }

  $('wpRatioGroup').onclick = (e) => {
    const btn = e.target.closest('.wp-ratio-btn');
    if (!btn) return;
    setCropRatio(btn.dataset.ratio);
  };

  $('wpCropBox').addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-handle]')?.dataset.handle || 'move';
    const frameRect = $('wpCropFrame').getBoundingClientRect();
    if (!frameRect.width || !frameRect.height) return;
    e.preventDefault();
    wpCrop.drag = {
      handle,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      frameW: frameRect.width,
      frameH: frameRect.height,
      orig: { ...wpCrop.rect },
    };
    try { $('wpCropBox').setPointerCapture(e.pointerId); } catch {}
  });

  $('wpCropBox').addEventListener('pointermove', (e) => {
    const d = wpCrop.drag;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.frameW;
    const dy = (e.clientY - d.startY) / d.frameH;
    const o = d.orig;
    const minW = Math.min(0.25, Math.max(0.06, 36 / d.frameW));
    const minH = Math.min(0.25, Math.max(0.06, 36 / d.frameH));
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    if (d.handle === 'move') {
      wpCrop.rect = {
        x: clamp(o.x + dx, 0, 1 - o.w),
        y: clamp(o.y + dy, 0, 1 - o.h),
        w: o.w,
        h: o.h,
      };
      renderCropBox();
      return;
    }

    let l = o.x, t = o.y, r = o.x + o.w, b = o.y + o.h;
    const hasW = d.handle.includes('w'), hasE = d.handle.includes('e');
    const hasN = d.handle.includes('n'), hasS = d.handle.includes('s');
    if (hasW) l = clamp(o.x + dx, 0, r - minW);
    if (hasE) r = clamp(o.x + o.w + dx, l + minW, 1);
    if (hasN) t = clamp(o.y + dy, 0, b - minH);
    if (hasS) b = clamp(o.y + o.h + dy, t + minH, 1);

    const aspect = getTargetAspect(wpCrop.ratioMode);
    if (aspect && wpCrop.natW && wpCrop.natH) {
      // Normalized height/width ratio k = (natW / natH) / aspect
      const k = (wpCrop.natW / wpCrop.natH) / aspect;
      let w = r - l, h = b - t;
      if ((hasN || hasS) && !(hasW || hasE)) {
        w = h / k;
        const cx = (o.x + o.x + o.w) / 2;
        const maxW = Math.min(1, 2 * Math.min(cx, 1 - cx));
        if (w > maxW) { w = maxW; h = w * k; }
        if (w < minW) { w = minW; h = w * k; }
        l = clamp(cx - w / 2, 0, 1 - w);
        r = l + w;
        if (hasN) t = Math.max(0, b - h); else b = Math.min(1, t + h);
      } else {
        // Corner or horizontal edge: drive from width (or vertical delta if larger on corner)
        if ((hasN || hasS) && Math.abs(dy) * d.frameH > Math.abs(dx) * d.frameW) {
          w = h / k;
        } else {
          h = w * k;
        }
        if ((hasW || hasE) && !(hasN || hasS)) {
          const cy = (o.y + o.y + o.h) / 2;
          const maxH = Math.min(1, 2 * Math.min(cy, 1 - cy));
          if (h > maxH) { h = maxH; w = h / k; }
          if (h < minH) { h = minH; w = h / k; }
          t = clamp(cy - h / 2, 0, 1 - h);
          b = t + h;
          if (hasW) l = Math.max(0, r - w); else r = Math.min(1, l + w);
        } else {
          const maxW = hasW ? r : (1 - l);
          const maxH = hasN ? b : (1 - t);
          if (w > maxW) { w = maxW; h = w * k; }
          if (h > maxH) { h = maxH; w = h / k; }
          if (w < minW) { w = minW; h = w * k; }
          if (h < minH) { h = minH; w = h / k; }
          if (hasW) l = r - w; else r = l + w;
          if (hasN) t = b - h; else b = t + h;
        }
      }
    } else if (wpCrop.ratioMode === 'full') {
      wpCrop.ratioMode = 'free';
      document.querySelectorAll('#wpRatioGroup .wp-ratio-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.ratio === 'free');
      });
    }

    wpCrop.rect = {
      x: clamp(l, 0, 1 - minW),
      y: clamp(t, 0, 1 - minH),
      w: clamp(r - l, minW, 1),
      h: clamp(b - t, minH, 1),
    };
    renderCropBox();
  });

  const endCropDrag = (e) => {
    if (!wpCrop.drag) return;
    try { $('wpCropBox').releasePointerCapture(wpCrop.drag.pointerId); } catch {}
    wpCrop.drag = null;
  };
  $('wpCropBox').addEventListener('pointerup', endCropDrag);
  $('wpCropBox').addEventListener('pointercancel', endCropDrag);

  function applyWallpaper(version = state.wp.version) {
    state.wp.version = Number(version) || 0;
    const has = state.wp.version > 0;
    document.documentElement.classList.toggle('has-wallpaper', has);
    document.documentElement.style.setProperty('--wp-opacity', String(state.wp.opacity / 100));
    document.documentElement.style.setProperty('--wp-blur', `${state.wp.blur}px`);
    const url = has ? `url('/api/wallpaper?v=${state.wp.version}')` : 'none';
    $('wpLayer').style.backgroundImage = url;
    $('wpBtn').classList.toggle('cyan', has);
    $('wpBtn').classList.toggle('ghost', !has);
    $('wpOpRange').value = String(state.wp.opacity);
    $('wpOpVal').textContent = String(state.wp.opacity);
    $('wpBlurRange').value = String(state.wp.blur);
    $('wpBlurVal').textContent = String(state.wp.blur);
    $('wpRecropBtn').style.display = has ? '' : 'none';
    const pv = $('wpPreview');
    pv.style.backgroundImage = url;
    pv.textContent = has ? '' : 'DEFAULT TACTICAL GRID';
  }
  applyWallpaper(0);
  $('wpBtn').onclick = () => { closeCropMode(); applyWallpaper(); $('wpDialog').showModal(); };
  $('wpUploadBtn').onclick = () => $('wpFile').click();
  $('wpCropCancel').onclick = () => closeCropMode();
  $('wpRecropBtn').onclick = () => {
    if (!state.wp.version) return;
    openCropMode(`/api/wallpaper?v=${state.wp.version}`, '');
  };
  $('wpFile').onchange = async () => {
    const file = $('wpFile').files?.[0];
    $('wpFile').value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) return alert('原图不能超过 20 MB');
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
      openCropMode(dataUrl, file.type || '');
    } catch (err) {
      alert(err.message);
    }
  };
  $('wpCropApply').onclick = async () => {
    if (!wpCrop.open) return;
    $('wpCropApply').disabled = true;
    $('wpCropApply').textContent = 'SAVING...';
    try {
      const img = $('wpCropImg');
      const { x, y, w, h } = wpCrop.rect;
      const isFull = x <= 0.002 && y <= 0.002 && w >= 0.996 && h >= 0.996;
      let outUrl = '';
      if (isFull && wpCrop.mime === 'image/gif' && wpCrop.srcDataUrl.startsWith('data:image/gif')) {
        outUrl = wpCrop.srcDataUrl;
      } else {
        const sx = Math.round(x * wpCrop.natW);
        const sy = Math.round(y * wpCrop.natH);
        const sw = Math.max(1, Math.min(wpCrop.natW - sx, Math.round(w * wpCrop.natW)));
        const sh = Math.max(1, Math.min(wpCrop.natH - sy, Math.round(h * wpCrop.natH)));
        const maxDim = 2560;
        const scale = Math.min(1, maxDim / Math.max(sw, sh));
        const dw = Math.max(1, Math.round(sw * scale));
        const dh = Math.max(1, Math.round(sh * scale));
        const canvas = document.createElement('canvas');
        canvas.width = dw;
        canvas.height = dh;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
        outUrl = canvas.toDataURL('image/webp', 0.92);
        if (!outUrl.startsWith('data:image/webp')) outUrl = canvas.toDataURL('image/jpeg', 0.92);
      }
      const res = await api('/api/wallpaper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl: outUrl }),
      });
      closeCropMode();
      applyWallpaper(res.updatedAt);
    } catch (err) {
      alert(err.message);
    } finally {
      $('wpCropApply').disabled = false;
      $('wpCropApply').textContent = 'APPLY CROP & SAVE';
    }
  };
  $('wpResetBtn').onclick = async () => {
    try {
      await api('/api/wallpaper', { method: 'DELETE' });
      closeCropMode();
      applyWallpaper(0);
    } catch (err) { alert(err.message); }
  };
  $('wpOpRange').oninput = () => {
    state.wp.opacity = Number($('wpOpRange').value);
    LS.set('fmux_wp_opacity', state.wp.opacity);
    applyWallpaper();
  };
  $('wpBlurRange').oninput = () => {
    state.wp.blur = Number($('wpBlurRange').value);
    LS.set('fmux_wp_blur', state.wp.blur);
    applyWallpaper();
  };
  return { applyWallpaper };
};
