// File: src/image-align.cpp
// Ultra-fast image alignment using ECC algorithm for Node-RED

#include <napi.h>
#include <opencv2/opencv.hpp>
#include <chrono>
#include <cstring>
#include <string>
#include <vector>
#include <cmath>
#include <algorithm>
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
                    bool pngOptimize = false,
                    bool returnMatrix = false,
                    const Napi::Value& polygonValue = Napi::Value())
        : Napi::AsyncWorker(callback),
          scale(scale),
          maxIterations(maxIterations),
          terminationEps(terminationEps),
          outputFormat(std::move(outputFormat)),
          quality(quality),
          pngOptimize(pngOptimize),
          returnMatrix(returnMatrix),
          alignmentSuccess(false),
          hasPolygon(false),
          isPolygonArray(false) {
        
        try {
            auto t0 = std::chrono::steady_clock::now();
            
            // Convert input images to OpenCV Mat
            referenceMat = ConvertToMat(referenceImage);
            targetMat = ConvertToMat(targetImage);
            
            // Parse polygon(s) if provided
            if (!polygonValue.IsNull() && !polygonValue.IsUndefined() && polygonValue.IsArray()) {
                Napi::Array polygonArray = polygonValue.As<Napi::Array>();
                if (polygonArray.Length() > 0) {
                    // Check if first element is a coordinate pair or another array
                    Napi::Value firstElement = polygonArray[0u];
                    
                    if (firstElement.IsArray()) {
                        Napi::Array firstArray = firstElement.As<Napi::Array>();
                        
                        // Check if it's a single polygon [[x,y], [x,y], ...]
                        // or array of polygons [[[x,y], [x,y], ...], ...]
                        if (firstArray.Length() >= 2 && 
                            firstArray.Get(0u).IsNumber() && 
                            firstArray.Get(1u).IsNumber()) {
                            // Single polygon
                            hasPolygon = true;
                            isPolygonArray = false;
                            originalPolygon.reserve(polygonArray.Length());
                            
                            for (uint32_t i = 0; i < polygonArray.Length(); i++) {
                                Napi::Value point = polygonArray[i];
                                if (point.IsArray()) {
                                    Napi::Array pointArray = point.As<Napi::Array>();
                                    if (pointArray.Length() >= 2) {
                                        double x = pointArray.Get(0u).As<Napi::Number>().DoubleValue();
                                        double y = pointArray.Get(1u).As<Napi::Number>().DoubleValue();
                                        originalPolygon.push_back(cv::Point2f(x, y));
                                    }
                                }
                            }
                        } else if (firstArray.Length() > 0 && firstArray.Get(0u).IsArray()) {
                            // Array of polygons
                            hasPolygon = true;
                            isPolygonArray = true;
                            originalPolygons.reserve(polygonArray.Length());
                            
                            for (uint32_t i = 0; i < polygonArray.Length(); i++) {
                                Napi::Value polyValue = polygonArray[i];
                                if (polyValue.IsArray()) {
                                    Napi::Array singlePolygon = polyValue.As<Napi::Array>();
                                    std::vector<cv::Point2f> polygon;
                                    polygon.reserve(singlePolygon.Length());
                                    
                                    for (uint32_t j = 0; j < singlePolygon.Length(); j++) {
                                        Napi::Value point = singlePolygon[j];
                                        if (point.IsArray()) {
                                            Napi::Array pointArray = point.As<Napi::Array>();
                                            if (pointArray.Length() >= 2) {
                                                double x = pointArray.Get(0u).As<Napi::Number>().DoubleValue();
                                                double y = pointArray.Get(1u).As<Napi::Number>().DoubleValue();
                                                polygon.push_back(cv::Point2f(x, y));
                                            }
                                        }
                                    }
                                    
                                    if (!polygon.empty()) {
                                        originalPolygons.push_back(polygon);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
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
                // Store transformation matrix if requested
                if (returnMatrix) {
                    transformationMatrix = transformMatrix.clone();
                }
                
                // Transform polygon(s) if provided
                if (hasPolygon) {
                    if (isPolygonArray) {
                        // Transform array of polygons
                        TransformPolygons(originalPolygons, transformMatrix, refWidth, refHeight);
                    } else if (!originalPolygon.empty()) {
                        // Transform single polygon
                        TransformPolygon(originalPolygon, transformMatrix, refWidth, refHeight);
                    }
                }
                
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
            
            // Add transformation matrix if requested and alignment succeeded
            if (returnMatrix && alignmentSuccess && !transformationMatrix.empty()) {
                Napi::Object matrix = Napi::Object::New(env);
                matrix.Set("dx", Napi::Number::New(env, transformationMatrix.at<float>(0, 2)));
                matrix.Set("dy", Napi::Number::New(env, transformationMatrix.at<float>(1, 2)));
                
                // Provide both 2x3 OpenCV matrix and standard 3x3 homogeneous matrix
                Napi::Array matrix2x3 = Napi::Array::New(env, 6);
                matrix2x3.Set(0u, Napi::Number::New(env, transformationMatrix.at<float>(0, 0)));
                matrix2x3.Set(1u, Napi::Number::New(env, transformationMatrix.at<float>(0, 1)));
                matrix2x3.Set(2u, Napi::Number::New(env, transformationMatrix.at<float>(0, 2)));
                matrix2x3.Set(3u, Napi::Number::New(env, transformationMatrix.at<float>(1, 0)));
                matrix2x3.Set(4u, Napi::Number::New(env, transformationMatrix.at<float>(1, 1)));
                matrix2x3.Set(5u, Napi::Number::New(env, transformationMatrix.at<float>(1, 2)));
                
                // Standard 3x3 homogeneous transformation matrix
                Napi::Array matrix3x3 = Napi::Array::New(env, 9);
                matrix3x3.Set(0u, Napi::Number::New(env, transformationMatrix.at<float>(0, 0))); // m00
                matrix3x3.Set(1u, Napi::Number::New(env, transformationMatrix.at<float>(0, 1))); // m01
                matrix3x3.Set(2u, Napi::Number::New(env, transformationMatrix.at<float>(0, 2))); // m02 (dx)
                matrix3x3.Set(3u, Napi::Number::New(env, transformationMatrix.at<float>(1, 0))); // m10
                matrix3x3.Set(4u, Napi::Number::New(env, transformationMatrix.at<float>(1, 1))); // m11
                matrix3x3.Set(5u, Napi::Number::New(env, transformationMatrix.at<float>(1, 2))); // m12 (dy)
                matrix3x3.Set(6u, Napi::Number::New(env, 0.0)); // m20 (always 0)
                matrix3x3.Set(7u, Napi::Number::New(env, 0.0)); // m21 (always 0)
                matrix3x3.Set(8u, Napi::Number::New(env, 1.0)); // m22 (always 1)
                
                matrix.Set("matrix2x3", matrix2x3);  // OpenCV format [a,b,dx,c,d,dy]
                matrix.Set("matrix3x3", matrix3x3);  // Standard homogeneous format
                matrix.Set("transform", matrix3x3);  // Alias for backward compatibility
                response.Set("transformMatrix", matrix);
            }
            
            // Add transformed polygon(s) if provided and transformed
            if (hasPolygon && alignmentSuccess) {
                if (isPolygonArray) {
                    // Return array of polygons
                    if (!transformedPolygons.empty()) {
                        Napi::Array polygonsArray = Napi::Array::New(env, transformedPolygons.size());
                        for (size_t i = 0; i < transformedPolygons.size(); i++) {
                            const auto& polygon = transformedPolygons[i];
                            Napi::Array polygonArray = Napi::Array::New(env, polygon.size());
                            for (size_t j = 0; j < polygon.size(); j++) {
                                Napi::Array point = Napi::Array::New(env, 2);
                                point.Set(0u, Napi::Number::New(env, polygon[j].x));
                                point.Set(1u, Napi::Number::New(env, polygon[j].y));
                                polygonArray.Set(static_cast<uint32_t>(j), point);
                            }
                            polygonsArray.Set(static_cast<uint32_t>(i), polygonArray);
                        }
                        response.Set("transformedPolygons", polygonsArray);
                    }
                } else {
                    // Return single polygon
                    if (!transformedPolygon.empty()) {
                        Napi::Array polygonArray = Napi::Array::New(env, transformedPolygon.size());
                        for (size_t i = 0; i < transformedPolygon.size(); i++) {
                            Napi::Array point = Napi::Array::New(env, 2);
                            point.Set(0u, Napi::Number::New(env, transformedPolygon[i].x));
                            point.Set(1u, Napi::Number::New(env, transformedPolygon[i].y));
                            polygonArray.Set(static_cast<uint32_t>(i), point);
                        }
                        response.Set("transformedPolygon", polygonArray);
                    }
                }
            }
            
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
    bool returnMatrix;
    
    // Image data
    cv::Mat referenceMat, targetMat, alignedImage;
    cv::Mat transformationMatrix;
    std::string referenceChannelOrder, targetChannelOrder, outputChannelOrder;
    bool alignmentSuccess;
    
    // Polygon data
    bool hasPolygon;
    bool isPolygonArray;
    std::vector<cv::Point2f> originalPolygon;  // For single polygon
    std::vector<cv::Point2f> transformedPolygon;  // For single polygon
    std::vector<std::vector<cv::Point2f>> originalPolygons;  // For array of polygons
    std::vector<std::vector<cv::Point2f>> transformedPolygons;  // For array of polygons
    
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
        return (channels == 4) ? "RGBA" : (channels == 3) ? "RGB" : "GRAY";
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

    // Prepare grayscale image for ECC by normalizing mean/variance
    bool PrepareAlignmentImage(const cv::Mat& src, cv::Mat& dst) {
        constexpr double eps = 1e-6;

        src.convertTo(dst, CV_32F);
        cv::Scalar mean, stddev;
        cv::meanStdDev(dst, mean, stddev);

        dst -= static_cast<float>(mean[0]);

        double stdVal = stddev[0];
        if (!std::isfinite(stdVal) || stdVal <= eps) {
            return false;
        }

        float scaleFactor = static_cast<float>(1.0 / stdVal);
        dst *= scaleFactor;
        return true;
    }
    
    // Find transformation matrix using ECC algorithm
    bool FindTransformation(const cv::Mat& refGray, const cv::Mat& targetGray, cv::Mat& transformMatrix) {
        try {
            int height = refGray.rows;
            int width = refGray.cols;
            
            // Downsample images for faster alignment
            int scaledWidth = std::max(1, static_cast<int>(std::round(width * scale)));
            int scaledHeight = std::max(1, static_cast<int>(std::round(height * scale)));
            
            cv::Mat refSmall, targetSmall;
            cv::resize(refGray, refSmall, cv::Size(scaledWidth, scaledHeight));
            cv::resize(targetGray, targetSmall, cv::Size(scaledWidth, scaledHeight));

            // Normalize exposure/contrast differences so ECC is less sensitive to lighting changes
            cv::Mat refPrepared, targetPrepared;
            bool refPreparedOk = PrepareAlignmentImage(refSmall, refPrepared);
            bool targetPreparedOk = PrepareAlignmentImage(targetSmall, targetPrepared);

            if (!refPreparedOk || !targetPreparedOk) {
                // Fallback to min-max normalization when variance is extremely low
                cv::normalize(refPrepared, refPrepared, 0.0f, 1.0f, cv::NORM_MINMAX);
                cv::normalize(targetPrepared, targetPrepared, 0.0f, 1.0f, cv::NORM_MINMAX);
            }
            
            // Initialize transformation matrix for translation-only motion
            transformMatrix = cv::Mat::eye(2, 3, CV_32F);
            
            // Set up termination criteria
            cv::TermCriteria criteria(cv::TermCriteria::COUNT | cv::TermCriteria::EPS, 
                                    maxIterations, terminationEps);
            
            // Find transformation using ECC
            double correlation = cv::findTransformECC(refPrepared, targetPrepared, transformMatrix, 
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
    
    // Transform single polygon coordinates
    void TransformPolygon(const std::vector<cv::Point2f>& polygon, const cv::Mat& transformMatrix, int width, int height) {
        transformedPolygon.clear();
        transformedPolygon.reserve(polygon.size());
        
        for (const auto& point : polygon) {
            // Convert from normalized (0-1) to pixel coordinates
            float px = point.x * width;
            float py = point.y * height;
            
            // Apply the transformation matrix
            // Since we're using WARP_INVERSE_MAP, we need to apply the inverse transform
            // For translation-only (2x3 matrix with identity rotation), the inverse is just negating the translation
            float transformedX = px - transformMatrix.at<float>(0, 2);
            float transformedY = py - transformMatrix.at<float>(1, 2);
            
            // Convert back to normalized coordinates
            float normalizedX = transformedX / width;
            float normalizedY = transformedY / height;
            
            // Clamp to valid range [0, 1]
            normalizedX = std::max(0.0f, std::min(1.0f, normalizedX));
            normalizedY = std::max(0.0f, std::min(1.0f, normalizedY));
            
            transformedPolygon.push_back(cv::Point2f(normalizedX, normalizedY));
        }
    }
    
    // Transform multiple polygons coordinates
    void TransformPolygons(const std::vector<std::vector<cv::Point2f>>& polygons, const cv::Mat& transformMatrix, int width, int height) {
        transformedPolygons.clear();
        transformedPolygons.reserve(polygons.size());
        
        for (const auto& polygon : polygons) {
            std::vector<cv::Point2f> transformedPoly;
            transformedPoly.reserve(polygon.size());
            
            for (const auto& point : polygon) {
                // Convert from normalized (0-1) to pixel coordinates
                float px = point.x * width;
                float py = point.y * height;
                
                // Apply the transformation matrix
                // Since we're using WARP_INVERSE_MAP, we need to apply the inverse transform
                // For translation-only (2x3 matrix with identity rotation), the inverse is just negating the translation
                float transformedX = px - transformMatrix.at<float>(0, 2);
                float transformedY = py - transformMatrix.at<float>(1, 2);
                
                // Convert back to normalized coordinates
                float normalizedX = transformedX / width;
                float normalizedY = transformedY / height;
                
                // Clamp to valid range [0, 1]
                normalizedX = std::max(0.0f, std::min(1.0f, normalizedX));
                normalizedY = std::max(0.0f, std::min(1.0f, normalizedY));
                
                transformedPoly.push_back(cv::Point2f(normalizedX, normalizedY));
            }
            
            transformedPolygons.push_back(transformedPoly);
        }
    }
};

// Main function exported to Node.js
Napi::Value ImageAlign(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    // Validate arguments - expect callback as last argument
    if (info.Length() < 3 || info.Length() > 11 || !info[info.Length() - 1].IsFunction()) {
        Napi::TypeError::New(env, "imageAlign(referenceImage, targetImage, [scale], [maxIterations], [terminationEps], [outputFormat], [quality], [pngOptimize], [returnMatrix], [polygon], callback)")
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
    bool returnMatrix = false;
    Napi::Value polygon = env.Null();
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
    if (info.Length() >= 10) {
        returnMatrix = info[8].As<Napi::Boolean>().Value();
        cbIdx = 9;
    }
    if (info.Length() >= 11) {
        polygon = info[9];
        cbIdx = 10;
    }
    
    // Create and queue worker
    ImageAlignWorker* worker = new ImageAlignWorker(callback, referenceImage, targetImage,
                                                   scale, maxIterations, terminationEps,
                                                   outputFormat, quality, pngOptimize, returnMatrix, polygon);
    worker->Queue();
    
    return env.Undefined();
}
