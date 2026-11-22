import { PaddleOCR } from '@paddleocr/paddleocr-js';

let enginePromise;

function getEngine() {
  if (!enginePromise) {
    enginePromise = PaddleOCR.create({
      textDetectionModelName: 'PP-OCRv5_mobile_det',
      textDetectionModelAsset: { url: new URL('./ocr-assets/PP-OCRv5_mobile_det_onnx_infer.tar', location.href).href },
      textRecognitionModelName: 'PP-OCRv5_mobile_rec',
      textRecognitionModelAsset: { url: new URL('./ocr-assets/PP-OCRv5_mobile_rec_onnx_infer.tar', location.href).href },
      ortOptions: {
        backend: 'wasm',
        wasmPaths: new URL('./ocr-assets/', location.href).href,
        numThreads: 1,
        simd: true
      }
    }).catch(error => {
      enginePromise = undefined;
      throw error;
    });
  }
  return enginePromise;
}

window.HandwritingOCR = {
  async recognize(image, onStage) {
    const engine = await getEngine();
    if (onStage) onStage('正在识别照片文字');
    const [result] = await engine.predict(image);
    return result.items
      .slice()
      .sort((a, b) => Math.min(...a.poly.map(p => p[1])) - Math.min(...b.poly.map(p => p[1])))
      .map(item => ({ text: item.text, score: item.score }));
  }
};
