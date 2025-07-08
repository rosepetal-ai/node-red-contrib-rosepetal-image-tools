{
  "targets": [
    {
      "target_name": "addon",
      "sources": [
        "src/main.cpp",
        "src/resize.cpp"
      ],
      "include_dirs": [
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
        "-fexceptions",
        "-frtti"
      ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "GCC_ENABLE_CPP_RTTI": "YES",
        "OTHER_CPLUSPLUSFLAGS": [
          "-std=c++17",
          "-O3"
        ]
      }
    }
  ]
}