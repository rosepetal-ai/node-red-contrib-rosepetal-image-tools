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
        "src/draw.cpp"
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
                "<(opencv_lib_dir)/libopencv_imgproc.a",
                "<(opencv_lib_dir)/libopencv_core.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/liblibjpeg-turbo.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/liblibpng.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/liblibwebp.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/libzlib.a",
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
              "ldflags": [
                "-static-libgcc",
                "-static-libstdc++"
              ]
            }],
            ["OS=='mac'", {
              "libraries": [
                "<(opencv_lib_dir)/libopencv_imgcodecs.a",
                "<(opencv_lib_dir)/libopencv_imgproc.a",
                "<(opencv_lib_dir)/libopencv_core.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/liblibjpeg-turbo.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/liblibpng.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/liblibwebp.a",
                "<(opencv_lib_dir)/opencv4/3rdparty/libzlib.a"
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
                "<(opencv_lib_dir)/opencv_imgproc4.lib",
                "<(opencv_lib_dir)/opencv_core4.lib",
                "<(opencv_lib_dir)/opencv4/3rdparty/libjpeg-turbo.lib",
                "<(opencv_lib_dir)/opencv4/3rdparty/libpng.lib",
                "<(opencv_lib_dir)/opencv4/3rdparty/libwebp.lib",
                "<(opencv_lib_dir)/opencv4/3rdparty/zlib.lib"
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
            "/usr/include/opencv4",
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "libraries": [
            "<!@(pkg-config --libs --cflags opencv4)"
          ],
          "cflags_cc": [
            "-std=c++17",
            "-O3",
            "-ffast-math",
            "-march=native",
            "-fexceptions",
            "-frtti",
            "-fno-omit-frame-pointer",
            "-funroll-loops",
            "-fstrict-aliasing",
            "-fopenmp",
            "-mavx2",
            "-ftree-vectorize",
            "-fprefetch-loop-arrays",
            "-finline-functions",
            "-flto",
            "-fipa-pta",
            "-fvect-cost-model=cheap",
            "-minline-all-stringops"
          ],
          "ldflags": [
            "-O3",
            "-march=native",
            "-fopenmp",
            "-lgomp",
            "-flto",
            "-fuse-linker-plugin"
          ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "GCC_ENABLE_CPP_RTTI": "YES",
            "OTHER_CPLUSPLUSFLAGS": [
              "-std=c++17",
              "-O3",
              "-ffast-math",
              "-march=native",
              "-funroll-loops"
            ]
          }
        }]
      ]
    }
  ]
}
