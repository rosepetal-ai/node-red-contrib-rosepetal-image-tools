#include <napi.h>
#include <opencv2/opencv.hpp>
#include <algorithm>
#include <cmath>
#include "utils.h"

// Mean SSIM over the valid mask (standard 11x11 Gaussian, sigma 1.5)
static double MaskedSSIM(const cv::Mat& img1, const cv::Mat& img2, const cv::Mat& valid) {
  const double C1 = 6.5025, C2 = 58.5225;
  cv::Mat a, b;
  img1.convertTo(a, CV_32F);
  img2.convertTo(b, CV_32F);
  const cv::Size k(11, 11);
  cv::Mat mu1, mu2;
  cv::GaussianBlur(a, mu1, k, 1.5);
  cv::GaussianBlur(b, mu2, k, 1.5);
  cv::Mat mu1sq = mu1.mul(mu1), mu2sq = mu2.mul(mu2), mu12 = mu1.mul(mu2);
  cv::Mat s1, s2, s12;
  cv::GaussianBlur(a.mul(a), s1, k, 1.5);  s1  -= mu1sq;
  cv::GaussianBlur(b.mul(b), s2, k, 1.5);  s2  -= mu2sq;
  cv::GaussianBlur(a.mul(b), s12, k, 1.5); s12 -= mu12;
  cv::Mat num = (2 * mu12 + C1).mul(2 * s12 + C2);
  cv::Mat den = (mu1sq + mu2sq + C1).mul(s1 + s2 + C2);
  cv::Mat map;
  cv::divide(num, den, map);
  return cv::mean(map, valid)[0];
}

class HeatDiffWorker final : public Napi::AsyncWorker {
public:
  HeatDiffWorker(Napi::Function cb,
                 const Napi::Value& jsImg1,
                 const Napi::Value& jsImg2,
                 int colormapType,
                 int blurSize,
                 int threshold,
                 std::string outputFormat,
                 int quality = 90,
                 bool pngOptimize = false,
                 bool computeStats = false,
                 bool emitImage = true,
                 bool computeSsim = true)
    : Napi::AsyncWorker(cb),
      colormapType(colormapType),
      blurSize(blurSize),
      threshold(threshold),
      outputFormat(std::move(outputFormat)),
      quality(quality),
      pngOptimize(pngOptimize),
      computeStats(computeStats),
      emitImage(emitImage),
      computeSsim(computeSsim)
  {
    const int64 t0 = cv::getTickCount();
    mat1 = ConvertToMat(jsImg1);
    mat2 = ConvertToMat(jsImg2);
    format1 = DetectChannelFormatShared(jsImg1, mat1);
    format2 = DetectChannelFormatShared(jsImg2, mat2);
    convertMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;
  }

protected:
  void Execute() override {
    const int64 t0 = cv::getTickCount();

    // Convert both to grayscale for diff computation
    cv::Mat gray1, gray2;

    if (mat1.channels() == 1) {
      gray1 = mat1;
    } else if (format1 == "BGR" || format1 == "BGRA") {
      cv::cvtColor(mat1, gray1, mat1.channels() == 4 ? cv::COLOR_BGRA2GRAY : cv::COLOR_BGR2GRAY);
    } else {
      cv::cvtColor(mat1, gray1, mat1.channels() == 4 ? cv::COLOR_RGBA2GRAY : cv::COLOR_RGB2GRAY);
    }

    if (mat2.channels() == 1) {
      gray2 = mat2;
    } else if (format2 == "BGR" || format2 == "BGRA") {
      cv::cvtColor(mat2, gray2, mat2.channels() == 4 ? cv::COLOR_BGRA2GRAY : cv::COLOR_BGR2GRAY);
    } else {
      cv::cvtColor(mat2, gray2, mat2.channels() == 4 ? cv::COLOR_RGBA2GRAY : cv::COLOR_RGB2GRAY);
    }

    // Resize if dimensions differ
    if (gray1.size() != gray2.size()) {
      cv::Size targetSize(std::max(gray1.cols, gray2.cols),
                          std::max(gray1.rows, gray2.rows));
      if (gray1.size() != targetSize) cv::resize(gray1, gray1, targetSize);
      if (gray2.size() != targetSize) cv::resize(gray2, gray2, targetSize);
    }

    // Absolute difference
    cv::Mat diff;
    cv::absdiff(gray1, gray2, diff);

    // Optional Gaussian blur to smooth noise
    if (blurSize > 0) {
      int ksize = blurSize | 1; // ensure odd
      cv::GaussianBlur(diff, diff, cv::Size(ksize, ksize), 0);
    }

    // Optional threshold to suppress small differences
    if (threshold > 0) {
      cv::threshold(diff, diff, threshold, 0, cv::THRESH_TOZERO);
    }

    if (computeStats) ComputeStats(diff, gray1, gray2);

    // Apply colormap (skipped in stats-only mode)
    if (emitImage) {
      cv::applyColorMap(diff, result, colormapType);
      // applyColorMap outputs BGR
      outputChannel = "BGR";
    }

    taskMs = (cv::getTickCount() - t0) / cv::getTickFrequency() * 1e3;

    if (emitImage && outputFormat != "raw") {
      cv::Mat tmp = PrepareForEncoding(result, outputChannel, outputFormat);
      encodeMs = EncodeToFormat(tmp, encodedBuf, outputFormat, quality, pngOptimize);
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Value jsImg = env.Null();
    if (emitImage) {
      jsImg = (outputFormat != "raw")
        ? VectorToBuffer(env, std::move(encodedBuf))
        : MatToRawJS(env, result, outputChannel);
    }

    Napi::Object out = Napi::Object::New(env);
    out.Set("image", jsImg);
    out.Set("timing", MakeTimingJS(env, convertMs, taskMs, encodeMs));

    if (computeStats) {
      Napi::Object st = Napi::Object::New(env);
      st.Set("validRatio",      statValidRatio);
      st.Set("changedRatio",    statChangedRatio);
      st.Set("meanDiff",        statMean);
      st.Set("maxDiff",         statMax);
      st.Set("p50",             statP50);
      st.Set("p95",             statP95);
      st.Set("p99",             statP99);
      st.Set("rmse",            statRmse);
      st.Set("psnr",            statPsnr);
      if (computeSsim) st.Set("ssim", statSsim);
      else             st.Set("ssim", env.Null());
      st.Set("threshold",       threshold);
      st.Set("blobCount",       statBlobCount);
      st.Set("largestBlobArea", statLargestBlobArea);
      Napi::Array arr = Napi::Array::New(env, statBlobs.size());
      for (size_t i = 0; i < statBlobs.size(); i++) {
        const BlobStat& b = statBlobs[i];
        Napi::Object o = Napi::Object::New(env);
        o.Set("x", b.x); o.Set("y", b.y); o.Set("w", b.w); o.Set("h", b.h);
        o.Set("area", b.area);
        o.Set("cx", b.cx); o.Set("cy", b.cy);
        arr.Set(static_cast<uint32_t>(i), o);
      }
      st.Set("blobs", arr);
      out.Set("stats", st);
    }

    Callback().Call({env.Null(), out});
  }

private:
  struct BlobStat { int x, y, w, h, area; double cx, cy; };
  static constexpr size_t kMaxBlobs = 50;

  // All stats ignore pixels that are pure black in either input (alignment
  // borders / composite padding produce huge fake diffs there).
  void ComputeStats(const cv::Mat& diff, const cv::Mat& gray1, const cv::Mat& gray2) {
    const double total = static_cast<double>(diff.rows) * diff.cols;
    cv::Mat valid = (gray1 > 0) & (gray2 > 0);
    const int validCount = cv::countNonZero(valid);
    statValidRatio = validCount / total;
    if (validCount == 0) return;

    cv::Mat changed;
    cv::compare(diff, threshold, changed, cv::CMP_GT);
    changed &= valid;
    statChangedRatio = cv::countNonZero(changed) / static_cast<double>(validCount);

    statMean = cv::mean(diff, valid)[0];
    double maxVal = 0;
    cv::minMaxLoc(diff, nullptr, &maxVal, nullptr, nullptr, valid);
    statMax = maxVal;

    // Percentiles of the diff values via a masked 256-bin histogram
    int histSize = 256;
    float range[] = {0, 256};
    const float* ranges[] = {range};
    cv::Mat hist;
    cv::calcHist(&diff, 1, nullptr, valid, hist, 1, &histSize, ranges);
    double cum = 0;
    statP50 = statP95 = statP99 = -1;
    for (int i = 0; i < histSize; i++) {
      cum += hist.at<float>(i);
      const double frac = cum / validCount;
      if (statP50 < 0 && frac >= 0.50) statP50 = i;
      if (statP95 < 0 && frac >= 0.95) statP95 = i;
      if (statP99 < 0 && frac >= 0.99) { statP99 = i; break; }
    }

    cv::Mat diffF;
    diff.convertTo(diffF, CV_32F);
    const double meanSq = cv::mean(diffF.mul(diffF), valid)[0];
    statRmse = std::sqrt(meanSq);
    statPsnr = meanSq > 0 ? 10.0 * std::log10(255.0 * 255.0 / meanSq) : 100.0;

    // SSIM is by far the costliest stat (6 full-res float blurs); optional
    if (computeSsim) statSsim = MaskedSSIM(gray1, gray2, valid);

    // Connected components on the changed mask -> blobs (largest first, capped)
    cv::Mat labels, ccStats, centroids;
    const int n = cv::connectedComponentsWithStats(changed, labels, ccStats, centroids, 8, CV_32S);
    statBlobCount = n - 1;
    std::vector<BlobStat> blobs;
    blobs.reserve(n - 1);
    for (int i = 1; i < n; i++) {
      blobs.push_back({ccStats.at<int>(i, cv::CC_STAT_LEFT),
                       ccStats.at<int>(i, cv::CC_STAT_TOP),
                       ccStats.at<int>(i, cv::CC_STAT_WIDTH),
                       ccStats.at<int>(i, cv::CC_STAT_HEIGHT),
                       ccStats.at<int>(i, cv::CC_STAT_AREA),
                       centroids.at<double>(i, 0),
                       centroids.at<double>(i, 1)});
    }
    std::sort(blobs.begin(), blobs.end(),
              [](const BlobStat& a, const BlobStat& b) { return a.area > b.area; });
    if (blobs.size() > kMaxBlobs) blobs.resize(kMaxBlobs);
    statLargestBlobArea = blobs.empty() ? 0 : blobs[0].area;
    statBlobs = std::move(blobs);
  }

  cv::Mat mat1, mat2, result;
  std::string format1, format2, outputChannel;
  int colormapType;
  int blurSize;
  int threshold;
  std::string outputFormat;
  int quality;
  bool pngOptimize;
  bool computeStats;
  bool emitImage;
  bool computeSsim;
  double convertMs = 0, taskMs = 0, encodeMs = 0;
  std::vector<uchar> encodedBuf;

  double statValidRatio = 0, statChangedRatio = 0, statMean = 0, statMax = 0;
  double statP50 = 0, statP95 = 0, statP99 = 0, statRmse = 0, statPsnr = 0, statSsim = 0;
  int statBlobCount = 0, statLargestBlobArea = 0;
  std::vector<BlobStat> statBlobs;
};

Napi::Value HeatDiff(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 3 || !info[info.Length() - 1].IsFunction()) {
    Napi::TypeError::New(env,
      "heatDiff(image1, image2, colormapType, [blurSize], [threshold], [outputFormat], [quality], [pngOptimize], [computeStats], [emitImage], [computeSsim], callback)")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Value jsImg1 = info[0];
  Napi::Value jsImg2 = info[1];
  int colormapType = info[2].As<Napi::Number>().Int32Value();

  int blurSize = 0;
  int threshold = 0;
  std::string outputFormat = "raw";
  int quality = 90;
  bool pngOptimize = false;
  bool computeStats = false;
  bool emitImage = true;
  bool computeSsim = true;
  size_t cbIdx = 3;

  if (info.Length() >= 5)  { blurSize = info[3].As<Napi::Number>().Int32Value(); cbIdx = 4; }
  if (info.Length() >= 6)  { threshold = info[4].As<Napi::Number>().Int32Value(); cbIdx = 5; }
  if (info.Length() >= 7)  { outputFormat = info[5].As<Napi::String>().Utf8Value(); cbIdx = 6; }
  if (info.Length() >= 8)  { quality = info[6].As<Napi::Number>().Int32Value(); cbIdx = 7; }
  if (info.Length() >= 9)  { pngOptimize = info[7].As<Napi::Boolean>().Value(); cbIdx = 8; }
  if (info.Length() >= 10) { computeStats = info[8].As<Napi::Boolean>().Value(); cbIdx = 9; }
  if (info.Length() >= 11) { emitImage = info[9].As<Napi::Boolean>().Value(); cbIdx = 10; }
  if (info.Length() >= 12) { computeSsim = info[10].As<Napi::Boolean>().Value(); cbIdx = 11; }

  (new HeatDiffWorker(info[cbIdx].As<Napi::Function>(),
    jsImg1, jsImg2, colormapType, blurSize, threshold, outputFormat, quality, pngOptimize,
    computeStats, emitImage, computeSsim))->Queue();
  return env.Undefined();
}
