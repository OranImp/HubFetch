{
  # Windows x64 Node-API addon `hubfetch_job`.
  #
  # Consumes the workspace-resolved node-addon-api package (pinned to the exact
  # version recorded in pnpm-lock.yaml — native-build.mjs refuses to build if
  # the resolved version drifts). Builds only against the Electron ABI via
  # `node-gyp rebuild --target=<electron-version> --dist-url=https://electronjs.org/headers`.
  #
  # Todo 26: hubfetch_job.cc (exports/probes) + job_handle.cc (the Windows Job
  # Object bridge). Todo 30 helper sources live under src/include/ and are
  # intentionally NOT compiled here.
  'targets': [
    {
      'target_name': 'hubfetch_job',
      'sources': ['src/hubfetch_job.cc', 'src/job_handle.cc'],
      'include_dirs': [
        '<!@(node -p "require(\'node-addon-api\').include")'
      ],
      'defines': ['NAPI_DISABLE_CPP_EXCEPTIONS'],
      'cflags_cc': ['-std=c++17'],
      'cflags!': ['-fno-exceptions'],
      'cflags_cc!': ['-fno-exceptions'],
      'msvs_settings': {
        'VCCLCompilerTool': {
          'AdditionalOptions': ['/std:c++17']
        }
      }
    }
  ]
}
