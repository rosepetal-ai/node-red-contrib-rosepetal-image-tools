// File: src/image-align.cpp
// Ultra-fast image alignment using ECC algorithm for Node-RED

#include <napi.h>
#include <opencv2/opencv.hpp>
#include <chrono>
#include <cstring>
#include <string>
#include <vector>
#include <cmath>
#include <utility>
#include "utils.h"

class ImageAlignWorker : public Napi::AsyncWorker {
public:
    ImageAlignWorker(Napi::Function& callback,
                    const Napi::Value& referenceImage,
                    const Napi::Value& targetImage,
                    double scale,
                    int maxIterations,
                    double terminationEps,
                    std::string outputFormat,
                    int quality = 90,
                    bool pngOptimize = false)
        : Napi::AsyncWorker(callback),
          scale(scale),
          maxIterations(maxIterations),
          terminationEps(terminationEps),
          outputFormat(std::move(outputFormat)),
          quality(quality),
          pngOptimize(pngOptimize),
          alignmentSuccess(false) {
        
        try {
            auto t0 = std::chrono::steady_clock::now();
            
            // Convert input images to OpenCV Mat
            referenceMat = ConvertToMat(referenceImage);
            targetMat = ConvertToMat(targetImage);
            
            // Detect channel format for output
            referenceChannelOrder = DetectChannelFormat(referenceImage, referenceMat);
            targetChannelOrder = DetectChannelFormat(targetImage, targetMat);
            
            // Use reference image format for output
            outputChannelOrder = referenceChannelOrder;
            
            auto t1 = std::chrono::steady_clock::now();
            convertMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
            
        } catch (const Napi::Error& e) {
            SetError(e.Message());
        }
    }

protected:
    void Execute() override {
        try {
            auto taskStart = std::chrono::steady_clock::now();
            
            // Get reference dimensions
            int refHeight = referenceMat.rows;
            int refWidth = referenceMat.cols;
            
            // Resize target image to match reference dimensions
            cv::Mat targetResized;
            if (targetMat.size() != referenceMat.size()) {
                cv::resize(targetMat, targetResized, cv::Size(refWidth, refHeight));
            } else {
                targetResized = targetMat;
            }
            
            // Convert images to grayscale for alignment
            cv::Mat refGray, targetGray;
            ConvertToGray(referenceMat, refGray);
            ConvertToGray(targetResized, targetGray);
            
            // Find transformation matrix
            cv::Mat transformMatrix;
            alignmentSuccess = FindTransformation(refGray, targetGray, transformMatrix);
            
            if (alignmentSuccess) {
                // Apply transformation to the color target image
                ApplyTransformation(targetResized, transformMatrix, cv::Size(refWidth, refHeight));
            } else {
                // If alignment fails, use the resized target as-is
                alignedImage = targetResized;
            }
            
            auto taskEnd = std::chrono::steady_clock::now();
            taskMs = std::chrono::duration<double, std::milli>(taskEnd - taskStart).count();
            
        } catch (const std::exception& e) {
            SetError(std::string("Image alignment failed: ") + e.what());
        }
    }

    void OnOK() override {
        Napi::Env env = Env();
        
        try {
            auto encodeStart = std::chrono::steady_clock::now();
            Napi::Value result;
            
            if (outputFormat == "raw") {
                // Return raw image object
                result = MatToRawJS(env, alignedImage, outputChannelOrder);
            } else {
                // Encode to specified format
                std::vector<uchar> encoded;
                EncodeToFormat(alignedImage, encoded, outputFormat, quality, pngOptimize);
                result = VectorToBuffer(env, std::move(encoded));
            }
            
            auto encodeEnd = std::chrono::steady_clock::now();
            encodeMs = std::chrono::duration<double, std::milli>(encodeEnd - encodeStart).count();
            
            // Create response object
            Napi::Object response = Napi::Object::New(env);
            response.Set("image", result);
            response.Set("timing", MakeTimingJS(env, convertMs, taskMs, encodeMs));
            response.Set("success", Napi::Boolean::New(env, alignmentSuccess));
            
            Callback().Call({env.Null(), response});
            
        } catch (const std::exception& e) {
            Callback().Call({Napi::Error::New(env, e.what()).Value()});
        }
    }

private:
    // Input parameters
    double scale;
    int maxIterations;
    double terminationEps;
    std::string outputFormat;
    int quality;
    bool pngOptimize;
    
    // Image data
    cv::Mat referenceMat, targetMat, alignedImage;
    std::string referenceChannelOrder, targetChannelOrder, outputChannelOrder;
    bool alignmentSuccess;
    
    // Timing
    double convertMs = 0.0;
    double taskMs = 0.0;
    double encodeMs = 0.0;
    
    // Helper to detect channel format
    std::string DetectChannelFormat(const Napi::Value& jsImg, const cv::Mat& mat) {
        if (jsImg.IsObject() && !jsImg.IsBuffer()) {
            Napi::Object obj = jsImg.As<Napi::Object>();
            if (obj.Has("colorSpace")) {
                return obj.Get("colorSpace").As<Napi::String>().Utf8Value();
            }
        }
        // Default based on channel count
        const int channels = mat.channels();
        return (channels == 4) ? "BGRA" : (channels == 3) ? "BGR" : "GRAY";
    }
    
    // Convert image to grayscale
    void ConvertToGray(const cv::Mat& src, cv::Mat& gray) {
        if (src.channels() == 1) {
            gray = src;
        } else if (src.channels() == 3) {
            cv::cvtColor(src, gray, cv::COLOR_BGR2GRAY);
        } else if (src.channels() == 4) {
            cv::cvtColor(src, gray, cv::COLOR_BGRA2GRAY);
        } else {
            throw std::runtime_error("Unsupported image format for alignment");
        }
    }
    
    // Find transformation matrix using ECC algorithm
    bool FindTransformation(const cv::Mat& refGray, const cv::Mat& targetGray, cv::Mat& transformMatrix) {
        try {
            int height = refGray.rows;
            int width = refGray.cols;
            
            // Downsample images for faster alignment
            int scaledWidth = static_cast<int>(width * scale);
            int scaledHeight = static_cast<int>(height * scale);
            
            cv::Mat refSmall, targetSmall;
            cv::resize(refGray, refSmall, cv::Size(scaledWidth, scaledHeight));
            cv::resize(targetGray, targetSmall, cv::Size(scaledWidth, scaledHeight));
            
            // Initialize transformation matrix for translation-only motion
            transformMatrix = cv::Mat::eye(2, 3, CV_32F);
            
            // Set up termination criteria
            cv::TermCriteria criteria(cv::TermCriteria::COUNT | cv::TermCriteria::EPS, 
                                    maxIterations, terminationEps);
            
            // Find transformation using ECC
            double correlation = cv::findTransformECC(refSmall, targetSmall, transformMatrix, 
                                                    cv::MOTION_TRANSLATION, criteria);
            
            // Scale transformation matrix back to full resolution
            transformMatrix.at<float>(0, 2) /= scale; // x translation
            transformMatrix.at<float>(1, 2) /= scale; // y translation
            
            return correlation > 0.1; // Simple success threshold
            
        } catch (const cv::Exception& e) {
            return false;
        }
    }
    
    // Apply transformation to image
    void ApplyTransformation(const cv::Mat& target, const cv::Mat& transformMatrix, const cv::Size& size) {
        try {
            cv::warpAffine(target, alignedImage, transformMatrix, size, 
                         cv::INTER_LINEAR + cv::WARP_INVERSE_MAP);
        } catch (const cv::Exception& e) {
            // If transformation fails, use original
            alignedImage = target;
        }
    }
};

// Main function exported to Node.js
Napi::Value ImageAlign(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    // Validate arguments - expect callback as last argument
    if (info.Length() < 3 || info.Length() > 9 || !info[info.Length() - 1].IsFunction()) {
        Napi::TypeError::New(env, "imageAlign(referenceImage, targetImage, [scale], [maxIterations], [terminationEps], [outputFormat], [quality], [pngOptimize], callback)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    
    // Extract required arguments
    Napi::Value referenceImage = info[0];
    Napi::Value targetImage = info[1];
    Napi::Function callback = info[info.Length() - 1].As<Napi::Function>();
    
    // Handle optional parameters with defaults
    double scale = 0.2;              // Ultra-fast preset default
    int maxIterations = 10;
    double terminationEps = 1e-1;
    std::string outputFormat = "raw";
    int quality = 90;
    bool pngOptimize = false;
    size_t cbIdx = 2;
    
    // Parse optional parameters (before callback)
    if (info.Length() >= 4) {
        scale = info[2].As<Napi::Number>().DoubleValue();
        cbIdx = 3;
    }
    if (info.Length() >= 5) {
        maxIterations = info[3].As<Napi::Number>().Int32Value();
        cbIdx = 4;
    }
    if (info.Length() >= 6) {
        terminationEps = info[4].As<Napi::Number>().DoubleValue();
        cbIdx = 5;
    }
    if (info.Length() >= 7) {
        outputFormat = info[5].As<Napi::String>().Utf8Value();
        cbIdx = 6;
    }
    if (info.Length() >= 8) {
        quality = info[6].As<Napi::Number>().Int32Value();
        cbIdx = 7;
    }
    if (info.Length() >= 9) {
        pngOptimize = info[7].As<Napi::Boolean>().Value();
        cbIdx = 8;
    }
    
    // Create and queue worker
    ImageAlignWorker* worker = new ImageAlignWorker(callback, referenceImage, targetImage,
                                                   scale, maxIterations, terminationEps,
                                                   outputFormat, quality, pngOptimize);
    worker->Queue();
    
    return env.Undefined();
}