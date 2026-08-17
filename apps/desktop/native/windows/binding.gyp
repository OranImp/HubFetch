{
  # Windows x64 Node-API addon `hubfetch_job` + the packaged AskPass helper exe.
  #
  # Consumes the workspace-resolved node-addon-api package (pinned to the exact
  # version recorded in pnpm-lock.yaml — native-build.mjs refuses to build if
  # the resolved version drifts). Builds only against the Electron ABI via
  # `node-gyp rebuild --target=<electron-version> --dist-url=https://electronjs.org/headers`.
  #
  # Todo 26: hubfetch_job.cc (exports/probes) + job_handle.cc (the Windows Job
  # Object bridge). Todo 30: askpass_session.cc (Job-bound AskPass session) is
  # compiled INTO the addon; the standalone console helper
  # (src/include/askpass_main.cc) is a separate executable target whose sources
  # live under src/include/ and never enter the addon.
  'targets': [
    {
      'target_name': 'hubfetch_job',
      'sources': [
        'src/hubfetch_job.cc',
        'src/job_handle.cc',
        'src/askpass_session.cc'
      ],
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
    },
    {
      # Todo 30: the packaged GIT_ASKPASS console helper. Console subsystem,
      # x64 PE, no Node/Electron dependency: it talks to the AskPass session
      # pipe only. Node-gyp emits build/Release/HubFetchAskPass.exe.
      'target_name': 'HubFetchAskPass',
      'type': 'executable',
      'sources': ['src/include/askpass_main.cc'],
      'defines': ['_CRT_SECURE_NO_WARNINGS'],
      'msvs_settings': {
        'VCLinkerTool': {
          'SubSystem': '1'  # CONSOLE
        }
      }
    }
  ]
}