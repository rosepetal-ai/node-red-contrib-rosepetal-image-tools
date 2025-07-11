{
  "targets": [
    {
      "target_name": "addon",
      "sources": [
        "src/main.cpp",
        "src/resize.cpp",
        "src/rotate.cpp"
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
        "-fstrict-aliasing"
      ],
      "ldflags": [
        "-O3",
        "-march=native"
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
