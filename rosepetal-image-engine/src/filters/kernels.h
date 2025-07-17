// ───────── src/filters/kernels.h (optimized kernel definitions) ─────────
#ifndef KERNELS_H
#define KERNELS_H

#include <opencv2/opencv.hpp>
#include <vector>

// Optimized kernel creation functions for image filtering

/**
 * Creates a sharpening kernel with configurable size and intensity
 * @param size Kernel size (3, 5, 7, etc.) - must be odd
 * @param intensity Sharpening intensity (0.0 to 2.0)
 * @return OpenCV Mat kernel
 */
inline cv::Mat CreateSharpenKernel(int size, double intensity) {
    cv::Mat kernel = cv::Mat::zeros(size, size, CV_32F);
    
    // Create basic sharpening kernel
    if (size == 3) {
        // Standard 3x3 sharpening kernel
        kernel.at<float>(0, 1) = -intensity;
        kernel.at<float>(1, 0) = -intensity;
        kernel.at<float>(1, 1) = 1.0f + 4.0f * intensity;
        kernel.at<float>(1, 2) = -intensity;
        kernel.at<float>(2, 1) = -intensity;
    } else {
        // Larger kernels: create center-weighted sharpening
        int center = size / 2;
        float neighbors = 0.0f;
        
        // Set negative values for immediate neighbors
        for (int i = 0; i < size; i++) {
            for (int j = 0; j < size; j++) {
                if (i == center && j == center) {
                    continue; // Skip center, set later
                }
                
                // Distance from center
                int dx = abs(i - center);
                int dy = abs(j - center);
                
                if (dx <= 1 && dy <= 1 && (dx + dy) <= 2) {
                    float weight = -intensity / (dx + dy + 1);
                    kernel.at<float>(i, j) = weight;
                    neighbors += weight;
                }
            }
        }
        
        // Set center value to maintain sum = 1
        kernel.at<float>(center, center) = 1.0f - neighbors;
    }
    
    return kernel;
}

/**
 * Creates an emboss kernel with configurable intensity
 * @param intensity Emboss intensity (0.0 to 2.0)
 * @return OpenCV Mat kernel
 */
inline cv::Mat CreateEmbossKernel(double intensity) {
    cv::Mat kernel = cv::Mat::zeros(3, 3, CV_32F);
    
    // Standard emboss kernel with intensity scaling
    kernel.at<float>(0, 0) = -2.0f * intensity;
    kernel.at<float>(0, 1) = -1.0f * intensity;
    kernel.at<float>(0, 2) = 0.0f;
    kernel.at<float>(1, 0) = -1.0f * intensity;
    kernel.at<float>(1, 1) = 1.0f;
    kernel.at<float>(1, 2) = 1.0f * intensity;
    kernel.at<float>(2, 0) = 0.0f;
    kernel.at<float>(2, 1) = 1.0f * intensity;
    kernel.at<float>(2, 2) = 2.0f * intensity;
    
    return kernel;
}

/**
 * Creates a box blur kernel of specified size
 * @param size Kernel size (3, 5, 7, etc.) - must be odd
 * @return OpenCV Mat kernel
 */
inline cv::Mat CreateBoxBlurKernel(int size) {
    float value = 1.0f / (size * size);
    return cv::Mat::ones(size, size, CV_32F) * value;
}

/**
 * Creates edge detection kernels (Sobel variants)
 * @param direction 0 = horizontal, 1 = vertical, 2 = both
 * @param size Kernel size (3, 5, 7)
 * @return OpenCV Mat kernel
 */
inline cv::Mat CreateEdgeKernel(int direction, int size) {
    cv::Mat kernel = cv::Mat::zeros(size, size, CV_32F);
    
    if (size == 3) {
        if (direction == 0) { // Horizontal Sobel
            kernel.at<float>(0, 0) = -1; kernel.at<float>(0, 1) = 0; kernel.at<float>(0, 2) = 1;
            kernel.at<float>(1, 0) = -2; kernel.at<float>(1, 1) = 0; kernel.at<float>(1, 2) = 2;
            kernel.at<float>(2, 0) = -1; kernel.at<float>(2, 1) = 0; kernel.at<float>(2, 2) = 1;
        } else if (direction == 1) { // Vertical Sobel
            kernel.at<float>(0, 0) = -1; kernel.at<float>(0, 1) = -2; kernel.at<float>(0, 2) = -1;
            kernel.at<float>(1, 0) = 0;  kernel.at<float>(1, 1) = 0;  kernel.at<float>(1, 2) = 0;
            kernel.at<float>(2, 0) = 1;  kernel.at<float>(2, 1) = 2;  kernel.at<float>(2, 2) = 1;
        } else { // Laplacian
            kernel.at<float>(0, 0) = 0; kernel.at<float>(0, 1) = -1; kernel.at<float>(0, 2) = 0;
            kernel.at<float>(1, 0) = -1; kernel.at<float>(1, 1) = 4; kernel.at<float>(1, 2) = -1;
            kernel.at<float>(2, 0) = 0; kernel.at<float>(2, 1) = -1; kernel.at<float>(2, 2) = 0;
        }
    } else {
        // For larger kernels, use OpenCV's built-in Sobel generation
        cv::getDerivKernels(kernel, cv::Mat(), direction == 0 ? 1 : 0, direction == 1 ? 1 : 0, size);
    }
    
    return kernel;
}

/**
 * Utility function to validate and adjust kernel size
 * @param size Input kernel size
 * @return Valid odd kernel size between 3 and 15
 */
inline int ValidateKernelSize(int size) {
    // Ensure odd size
    if (size % 2 == 0) {
        size++;
    }
    
    // Clamp to reasonable range
    return std::max(3, std::min(size, 15));
}

/**
 * Utility function to validate and clamp intensity values
 * @param intensity Input intensity
 * @param min Minimum value
 * @param max Maximum value
 * @return Clamped intensity value
 */
inline double ValidateIntensity(double intensity, double min = 0.0, double max = 2.0) {
    return std::max(min, std::min(intensity, max));
}

/**
 * Pre-computed optimized kernels for common operations
 */
namespace OptimizedKernels {
    // Common 3x3 kernels
    const cv::Mat SHARPEN_3X3 = (cv::Mat_<float>(3, 3) <<
        0, -1, 0,
        -1, 5, -1,
        0, -1, 0
    );
    
    const cv::Mat EMBOSS_3X3 = (cv::Mat_<float>(3, 3) <<
        -2, -1, 0,
        -1, 1, 1,
        0, 1, 2
    );
    
    const cv::Mat EDGE_3X3 = (cv::Mat_<float>(3, 3) <<
        0, -1, 0,
        -1, 4, -1,
        0, -1, 0
    );
}

#endif // KERNELS_H