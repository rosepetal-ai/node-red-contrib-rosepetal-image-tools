{
  "variables": {
    "opencv_include_dir%": "",
    "opencv_lib_dir%": ""
  },
  "targets": [
    {
      "target_name": "addon",
      "sources": [
        "src/main.cpp",
        "src/resize.cpp",
        "src/rotate.cpp",
        "src/crop.cpp",
        "src/concat.cpp",
        "src/padding.cpp",
        "src/filter.cpp",
        "src/mosaic.cpp",
        "src/advanced-mosaic.cpp",
        "src/blend.cpp",
        "src/add-mask.cpp",
        "src/add-masks.cpp",
        "src/add-bbs.cpp",
        "src/image-align.cpp",
        "src/draw.cpp",
        "src/color-convert.cpp",
        "src/heat-diff.cpp",
        "src/codec.cpp"
      ],
      "defines": [
        "NAPI_CPP_EXCEPTIONS"
      ],
      "conditions": [
        ["opencv_lib_dir!=''", {
          "include_dirs": [
            "<(opencv_include_dir)",
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "conditions": [
            ["OS=='linux'", {
              "libraries": [
                "<(opencv_lib_dir)/libopencv_imgcodecs.a",
                "<(opencv_lib_dir)/libopencv_calib3d.a",
                "<(opencv_lib_dir)/libopencv_features2d.a",
                "<(opencv_lib_dir)/libopencv_flann.a",
                "<(opencv_lib_dir)/libopencv_video.a",
                "<(opencv_lib_dir)/libopencv_imgproc.a",
                "<(opencv_lib_dir)/libopencv_core.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/liblibjpeg-turbo.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/liblibpng.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/liblibwebp.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/libzlib.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/libtbb.a",
                "-lpthread",
                "-ldl"
              ],
              "cflags_cc": [
                "-std=c++17",
                "-O3",
                "-fexceptions",
                "-frtti",
                "-fno-omit-frame-pointer"
              ],
              "conditions": [
                ["target_arch=='x64'", {
                  "cflags_cc": [
                    "-march=x86-64-v3",
                    "-mtune=generic"
                  ]
                }],
                ["target_arch=='arm64'", {
                  "cflags_cc": [
                    "-march=armv8-a"
                  ]
                }]
              ],
              "ldflags": [
                "-static-libgcc",
                "-static-libstdc++"
              ]
            }],
            ["OS=='mac'", {
              "libraries": [
                "<(opencv_lib_dir)/libopencv_imgcodecs.a",
                "<(opencv_lib_dir)/libopencv_calib3d.a",
                "<(opencv_lib_dir)/libopencv_features2d.a",
                "<(opencv_lib_dir)/libopencv_flann.a",
                "<(opencv_lib_dir)/libopencv_video.a",
                "<(opencv_lib_dir)/libopencv_imgproc.a",
                "<(opencv_lib_dir)/libopencv_core.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/liblibjpeg-turbo.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/liblibpng.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/liblibwebp.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/libzlib.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/libtbb.a"
              ],
              "xcode_settings": {
                "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
                "GCC_ENABLE_CPP_RTTI": "YES",
                "MACOSX_DEPLOYMENT_TARGET": "10.15",
                "OTHER_CPLUSPLUSFLAGS": [
                  "-std=c++17",
                  "-O3"
                ]
              }
            }],
            ["OS=='win'", {
              "libraries": [
                "<(opencv_lib_dir)/opencv_imgcodecs4.lib",
                "<(opencv_lib_dir)/opencv_calib3d4.lib",
                "<(opencv_lib_dir)/opencv_features2d4.lib",
                "<(opencv_lib_dir)/opencv_flann4.lib",
                "<(opencv_lib_dir)/opencv_video4.lib",
                "<(opencv_lib_dir)/opencv_imgproc4.lib",
                "<(opencv_lib_dir)/opencv_core4.lib",
                "<(opencv_lib_dir)/opencv4/3rdparty/libjpeg-turbo.lib",
                "<(opencv_lib_dir)/opencv4/3rdparty/libpng.lib",
                "<(opencv_lib_dir)/opencv4/3rdparty/libwebp.lib",
                "<(opencv_lib_dir)/opencv4/3rdparty/zlib.lib",
                "<(opencv_lib_dir)/opencv4/3rdparty/tbb.lib"
              ],
              "msvs_settings": {
                "VCCLCompilerTool": {
                  "RuntimeLibrary": 0,
                  "ExceptionHandling": 1,
                  "AdditionalOptions": ["/std:c++17"]
                }
              }
            }]
          ]
        }, {
          "include_dirs": [
            "<!@(pkg-config --cflags-only-I opencv4 | sed s/-I//g)",
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "libraries": [
            "<!@(pkg-config --libs opencv4)"
          ],
          "cflags_cc": [
            "-std=c++17",
            "-O3",
            "-fexceptions",
            "-frtti",
            "-fno-omit-frame-pointer",
            "-fopenmp"
          ],
          "ldflags": [
            "-O3",
            "-fopenmp"
          ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "GCC_ENABLE_CPP_RTTI": "YES",
            "OTHER_CPLUSPLUSFLAGS": [
              "-std=c++17",
              "-O3",
              "-march=native"
            ]
          }
        }]
      ]
    }
  ]
}
