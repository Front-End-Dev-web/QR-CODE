(async () => {
    // UI references
    const video = document.getElementById('video');
    const overlay = document.getElementById('overlay');
    const ctx = overlay.getContext('2d');
    const detectedNameEl = document.getElementById('detectedName');
    const qrResultEl = document.getElementById('qrResult');
    const errorMsg = document.getElementById('errorMsg');
    const switchBtn = document.getElementById('switchBtn');
    const flashBtn = document.getElementById('flashBtn');
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const captureBtn = document.getElementById('captureBtn');
    const recordBtn = document.getElementById('recordBtn');
    const preview = document.getElementById('preview');
    const downloadPhotoBtn = document.getElementById('downloadPhotoBtn');
    const downloadVideoBtn = document.getElementById('downloadVideoBtn');

    // State
    let devices = [];
    let currentDeviceIndex = 0;
    let currentStream = null;
    let videoTrack = null;
    let torchSupported = false;
    let zoomCap = null;
    let currentZoom = 1;
    let mpCamera = null;
    let pose = null;

    const scanCanvas = document.createElement('canvas');
    const scanCtx = scanCanvas.getContext('2d');
    let qrIntervalId = null;

    // Eye indices
    const LEFT_EYE = 2, RIGHT_EYE = 5;
    const EYE_NAMES = { [LEFT_EYE]: 'Left Eye', [RIGHT_EYE]: 'Right Eye' };

    function showError(msg){ errorMsg.textContent=msg; console.warn(msg); }
    function clearError(){ errorMsg.textContent=''; }

    async function waitMeta(){ 
      if(video.readyState>=2) return;
      await new Promise(r=>video.addEventListener('loadedmetadata',r,{once:true}));
    }

    async function enumerateDevices(){
      const all=await navigator.mediaDevices.enumerateDevices();
      devices=all.filter(d=>d.kind==='videoinput');
      const rear=devices.findIndex(d=>/back|rear|environment/i.test(d.label));
      if(rear>=0) currentDeviceIndex=rear;
      switchBtn.disabled=devices.length<=1;
    }

    async function startCamera(deviceId){
      if(currentStream) currentStream.getTracks().forEach(t=>t.stop());
      try{
        currentStream=await navigator.mediaDevices.getUserMedia(
          deviceId?{video:{deviceId:{exact:deviceId}},audio:false}:{video:{facingMode:'environment'},audio:false}
        );
      }catch(e){ showError("Camera error: "+e.message); return false; }
      video.srcObject=currentStream;
      await waitMeta();

      overlay.width=video.videoWidth; overlay.height=video.videoHeight;
      scanCanvas.width=video.videoWidth; scanCanvas.height=video.videoHeight;

      videoTrack=currentStream.getVideoTracks()[0];
      const caps=videoTrack.getCapabilities?videoTrack.getCapabilities():{};
      zoomCap=caps.zoom||null; 
      zoomInBtn.disabled=zoomOutBtn.disabled=!zoomCap;
      torchSupported=!!caps.torch; flashBtn.disabled=!torchSupported;
      return true;
    }

    async function toggleTorch(){
      if(!videoTrack) return;
      const caps=videoTrack.getCapabilities();
      if(!caps.torch){ showError("Torch not supported"); return; }
      const on=flashBtn.dataset.on==='true';
      await videoTrack.applyConstraints({advanced:[{torch:!on}]});
      flashBtn.dataset.on=(!on).toString();
      flashBtn.textContent=!on?'🔦 Flash On':'🔦 Flash Off';
    }

    async function applyZoom(d){
      if(!videoTrack||!zoomCap) return;
      const s=videoTrack.getSettings();
      const cur=s.zoom||zoomCap.min||1;
      const step=zoomCap.step||0.2;
      const nz=Math.max(zoomCap.min,Math.min(zoomCap.max,cur+d*step));
      await videoTrack.applyConstraints({advanced:[{zoom:nz}]});
      currentZoom=nz;
    }

    function capturePhoto(){
      const c=document.createElement('canvas');
      c.width=overlay.width; c.height=overlay.height;
      const cctx=c.getContext('2d');
      cctx.drawImage(video,0,0,c.width,c.height);
      cctx.drawImage(overlay,0,0,c.width,c.height);
      const url=c.toDataURL("image/png");
      preview.innerHTML=`<img src="${url}"/>`;
      downloadPhotoBtn.style.display='inline-block';
      downloadPhotoBtn.onclick=()=>{const a=document.createElement('a');a.href=url;a.download="photo.png";a.click();};
    }

    // Recording
    let mediaRecorder=null,chunks=[];
    function startRecording(){
      const comp=document.createElement('canvas');
      comp.width=overlay.width; comp.height=overlay.height;
      const cc=comp.getContext('2d');
      function loop(){ if(mediaRecorder&&mediaRecorder.state==="recording"){cc.drawImage(video,0,0,comp.width,comp.height);cc.drawImage(overlay,0,0,comp.width,comp.height);requestAnimationFrame(loop);} }
      loop();
      const stream=comp.captureStream(25);
      mediaRecorder=new MediaRecorder(stream);
      chunks=[];
      mediaRecorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
      mediaRecorder.onstop=()=>{const b=new Blob(chunks,{type:"video/webm"});const url=URL.createObjectURL(b);preview.innerHTML=`<video controls src="${url}"></video>`;downloadVideoBtn.style.display='inline-block';downloadVideoBtn.onclick=()=>{const a=document.createElement('a');a.href=url;a.download="video.webm";a.click();};};
      mediaRecorder.start();
      recordBtn.textContent="⏹️ Stop";
    }
    function stopRecording(){ if(mediaRecorder&&mediaRecorder.state==="recording") mediaRecorder.stop(); recordBtn.textContent="⏺️ Record"; }

    // Pose setup
    function initPose(){
      pose=new Pose({locateFile:(f)=>`https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}`});
      pose.setOptions({modelComplexity:1,minDetectionConfidence:0.6,minTrackingConfidence:0.6});
      pose.onResults(onPose);
    }
    function onPose(r){
      ctx.clearRect(0,0,overlay.width,overlay.height);
      const lm=r.poseLandmarks||[];
      const eyes=[];
      [LEFT_EYE,RIGHT_EYE].forEach(i=>{
        const p=lm[i]; if(p&&p.visibility>0.5){
          const x=p.x*overlay.width,y=p.y*overlay.height;
          ctx.beginPath();ctx.arc(x,y,10,0,2*Math.PI);ctx.strokeStyle="lime";ctx.lineWidth=3;ctx.stroke();
          eyes.push(EYE_NAMES[i]);
        }
      });
      detectedNameEl.textContent=eyes.length?eyes.join(", "):"None";
    }

    function startPose(){
      if(mpCamera) mpCamera.stop();
      mpCamera=new Camera(video,{onFrame:async()=>{await pose.send({image:video})},width:overlay.width,height:overlay.height});
      mpCamera.start();
    }

    // QR scanning
    function startQR(){
      if(qrIntervalId) clearInterval(qrIntervalId);
      qrIntervalId=setInterval(()=>{
        if(video.videoWidth===0) return;
        scanCtx.drawImage(video,0,0,scanCanvas.width,scanCanvas.height);
        const img=scanCtx.getImageData(0,0,scanCanvas.width,scanCanvas.height);
        const code=jsQR(img.data,img.width,img.height);
        if(code){
          qrResultEl.textContent=code.data;
          // If it's a URL, redirect
          if(/^https?:\/\//i.test(code.data)){
            window.location.href=code.data;
          }
        }
      },300);
    }

    // UI
    switchBtn.onclick=async()=>{currentDeviceIndex=(currentDeviceIndex+1)%devices.length;await startCamera(devices[currentDeviceIndex].deviceId);startPose();};
    flashBtn.onclick=toggleTorch;
    zoomInBtn.onclick=()=>applyZoom(1);
    zoomOutBtn.onclick=()=>applyZoom(-1);
    captureBtn.onclick=capturePhoto;
    recordBtn.onclick=()=>{if(mediaRecorder&&mediaRecorder.state==="recording")stopRecording();else startRecording();};

    // Init
    await enumerateDevices();
    await startCamera(devices[currentDeviceIndex]?.deviceId);
    initPose(); startPose(); startQR();
  })();