#!/usr/bin/env node

/**
 * Quick test script to verify multi-format implementation
 */

const CppProcessor = require('../node-red-contrib-rosepetal-image-tools/lib/cpp-bridge.js');

console.log('🔧 Testing Multi-Format Image Processing...\n');

// Create test image data
const width = 50;
const height = 50;
const channels = 3;
const imageData = Buffer.alloc(width * height * channels);

// Fill with gradient pattern
for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
        const index = (y * width + x) * channels;
        imageData[index] = Math.floor((x / width) * 255);     // Red gradient
        imageData[index + 1] = Math.floor((y / height) * 255); // Green gradient
        imageData[index + 2] = 128; // Blue constant
    }
}

const testImage = {
    data: imageData,
    width: width,
    height: height,
    channels: channels,
    colorSpace: 'RGB',
    dtype: 'uint8'
};

console.log(`📊 Test Image: ${width}x${height}, ${channels} channels, ${imageData.length} bytes\n`);

// Test formats
const formats = ['raw', 'jpg', 'png', 'webp'];
const testPromises = [];

formats.forEach(format => {
    const quality = (format === 'jpg' || format === 'webp') ? 85 : 90;
    
    console.log(`🔄 Testing ${format.toUpperCase()} format...`);
    
    // Test resize with this format
    const promise = CppProcessor.resize(testImage, 'percentage', 75, 'percentage', 75, format, quality)
        .then(result => {
            // Handle different return formats
            let resultSize;
            if (format === 'raw') {
                // Raw format returns an object with data property
                if (result.image && result.image.data) {
                    resultSize = result.image.data.length;
                } else {
                    throw new Error('Raw format missing image.data');
                }
            } else {
                // Encoded formats return buffer directly as image
                if (Buffer.isBuffer(result.image)) {
                    resultSize = result.image.length;
                } else {
                    throw new Error('Encoded format should return Buffer');
                }
            }
            
            const timing = result.timing || {};
            const totalTime = (timing.convertMs || 0) + (timing.taskMs || 0) + (timing.encodeMs || 0);
            
            console.log(`✅ ${format.toString().padEnd(4)} format: SUCCESS - Size: ${resultSize}b, Time: ${totalTime.toFixed(1)}ms`);
            return { format, success: true, size: resultSize, timing: totalTime };
        })
        .catch(error => {
            console.log(`❌ ${format.toString().padEnd(4)} format: FAILED - ${error.message}`);
            return { format, success: false, error: error.message };
        });
        
    testPromises.push(promise);
});

Promise.all(testPromises)
    .then(results => {
        console.log('\n=== TEST SUMMARY ===');
        
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        
        console.log(`Total Tests: ${results.length}`);
        console.log(`Successful: ${successful.length}`);
        console.log(`Failed: ${failed.length}`);
        console.log(`Success Rate: ${(successful.length / results.length * 100).toFixed(1)}%\n`);
        
        if (successful.length > 0) {
            console.log('✅ SUCCESSFUL FORMATS:');
            successful.forEach(result => {
                console.log(`  ${result.format}: ${result.size}b, ${result.timing.toFixed(1)}ms`);
            });
        }
        
        if (failed.length > 0) {
            console.log('\n❌ FAILED FORMATS:');
            failed.forEach(result => {
                console.log(`  ${result.format}: ${result.error}`);
            });
        }
        
        if (successful.length === formats.length) {
            console.log('\n🎉 All format tests passed! Ready for Node-RED testing.');
            process.exit(0);
        } else {
            console.log('\n⚠️  Some format tests failed. Check C++ implementation.');
            process.exit(1);
        }
    })
    .catch(error => {
        console.error('💥 Test framework error:', error.message);
        process.exit(1);
    });