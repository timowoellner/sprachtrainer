// Mikrofonzugriff und Weitergabe der Rohsamples an den Detektor.

export async function startMicrophone(onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true, // hält den eigenen Piepton aus der Analyse heraus
      noiseSuppression: false, // würde gehaltene Laute glätten und verfälschen
      autoGainControl: false,
    },
  });
  const ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);

  let node;
  try {
    await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    node = new AudioWorkletNode(ctx, 'capture-processor');
    node.port.onmessage = (e) => onChunk(e.data);
  } catch (err) {
    // Fallback, z. B. wenn die Seite per file:// geöffnet wurde.
    console.warn('AudioWorklet nicht verfügbar, nutze ScriptProcessor', err);
    node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
  }
  source.connect(node);
  node.connect(mute);

  return {
    stream,
    sampleRate: ctx.sampleRate,
    async stop() {
      source.disconnect();
      node.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
    },
  };
}

// Audiodatei (z. B. Probe-Aufnahme) dekodieren und als Mono-Samples liefern.
export async function decodeFile(file) {
  const data = await file.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(data);
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
    }
    return { samples: mono, sampleRate: buf.sampleRate };
  } finally {
    await ctx.close();
  }
}
