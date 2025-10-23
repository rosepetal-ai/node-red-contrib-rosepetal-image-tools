{
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
      "include_dirs": [
        "/usr/include/opencv4",
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "libraries": [
        "<!@(pkg-config --libs --cflags opencv4)"
      ],
      "defines": [
        "NAPI_CPP_EXCEPTIONS"
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
    }
  ]
}
