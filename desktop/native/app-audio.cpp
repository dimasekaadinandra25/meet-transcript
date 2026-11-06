#include <windows.h>
#include <propidl.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <tlhelp32.h>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <string>
#include <vector>

namespace {

const CLSID kDeviceEnumeratorClass = {0xBCDE0395, 0xE52F, 0x467C, {0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}};
const IID kDeviceEnumerator = {0xA95664D2, 0x9614, 0x4F35, {0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}};
const IID kSessionManager = {0x77AA99A0, 0x1BD6, 0x484F, {0x8B, 0xC7, 0x2C, 0x65, 0x4C, 0x9A, 0x9B, 0x6F}};
const IID kSessionControl2 = {0xBFB7FF88, 0x7239, 0x4FC9, {0x8F, 0xA2, 0x07, 0xC9, 0x50, 0xBE, 0x9C, 0x6D}};
const IID kAudioClient = {0x1CB9AD4C, 0xDBFA, 0x4C32, {0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}};
const IID kCaptureClient = {0xC8ADBD64, 0xE71E, 0x48A0, {0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}};
const IID kCompletionHandler = {0x41D949AB, 0x9862, 0x444A, {0x80, 0xF6, 0xC2, 0x61, 0x33, 0x4D, 0xA5, 0xEB}};
const IID kAgileObject = {0x94EA2B94, 0xE9CC, 0x49E0, {0xC0, 0xFF, 0xEE, 0x64, 0xCA, 0x8F, 0x5B, 0x90}};
const IID kUnknown = {0x00000000, 0x0000, 0x0000, {0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};

const wchar_t kLoopbackDevice[] = L"VAD\\Process_Loopback";
const DWORD kActivationProcessLoopback = 1;
const DWORD kIncludeTargetTree = 0;
const DWORD kSampleRate = 48000;
const WORD kChannels = 2;
const WORD kBitsPerSample = 16;
const REFERENCE_TIME kBufferDuration = 2000000;
const DWORD kActivateTimeoutMs = 5000;
const int kExitFailed = 1;
const int kExitTargetGone = 3;

struct LoopbackParams {
  DWORD targetProcessId;
  DWORD mode;
};

struct ActivationParams {
  DWORD activationType;
  LoopbackParams loopback;
};

class Activation : public IActivateAudioInterfaceCompletionHandler {
 public:
  explicit Activation(HANDLE done) : done_(done) {}
  virtual ~Activation() = default;

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
    if (IsEqualIID(iid, kUnknown) || IsEqualIID(iid, kCompletionHandler) || IsEqualIID(iid, kAgileObject)) {
      *out = this;
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refs_); }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG left = InterlockedDecrement(&refs_);
    if (!left) delete this;
    return left;
  }
  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation*) override {
    SetEvent(done_);
    return S_OK;
  }

 private:
  LONG refs_ = 1;
  HANDLE done_;
};

using ActivateFn = HRESULT(WINAPI*)(LPCWSTR, REFIID, PROPVARIANT*, IActivateAudioInterfaceCompletionHandler*, IActivateAudioInterfaceAsyncOperation**);

int fail(const char* what, HRESULT code) {
  std::fprintf(stderr, "%s (0x%08lX)\n", what, static_cast<unsigned long>(code));
  return kExitFailed;
}

IAudioClient* activateLoopback(DWORD pid) {
  HMODULE library = LoadLibraryW(L"Mmdevapi.dll");
  auto activate = library ? reinterpret_cast<ActivateFn>(reinterpret_cast<void*>(GetProcAddress(library, "ActivateAudioInterfaceAsync"))) : nullptr;
  if (!activate) return nullptr;
  ActivationParams params{kActivationProcessLoopback, {pid, kIncludeTargetTree}};
  PROPVARIANT variant;
  PropVariantInit(&variant);
  variant.vt = VT_BLOB;
  variant.blob.cbSize = sizeof(params);
  variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  auto* handler = new Activation(done);
  IActivateAudioInterfaceAsyncOperation* operation = nullptr;
  IAudioClient* client = nullptr;
  HRESULT started = activate(kLoopbackDevice, kAudioClient, &variant, handler, &operation);
  if (SUCCEEDED(started) && WaitForSingleObject(done, kActivateTimeoutMs) == WAIT_OBJECT_0) {
    HRESULT result = E_FAIL;
    IUnknown* unknown = nullptr;
    if (SUCCEEDED(operation->GetActivateResult(&result, &unknown)) && SUCCEEDED(result) && unknown) {
      unknown->QueryInterface(kAudioClient, reinterpret_cast<void**>(&client));
      unknown->Release();
    }
  }
  if (operation) operation->Release();
  handler->Release();
  return client;
}

DWORD WINAPI watchInput(void* stop) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  char byte;
  DWORD read = 0;
  while (ReadFile(input, &byte, 1, &read, nullptr) && read) {}
  SetEvent(static_cast<HANDLE>(stop));
  return 0;
}

bool writeAll(HANDLE output, const BYTE* data, DWORD size) {
  while (size) {
    DWORD written = 0;
    if (!WriteFile(output, data, size, &written, nullptr) || !written) return false;
    data += written;
    size -= written;
  }
  return true;
}

int capture(DWORD pid) {
  HANDLE target = OpenProcess(SYNCHRONIZE, FALSE, pid);
  if (!target) return fail("target process not found", HRESULT_FROM_WIN32(GetLastError()));
  IAudioClient* client = activateLoopback(pid);
  if (!client) return fail("process loopback is not available", E_FAIL);

  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = kChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = kBitsPerSample;
  format.nBlockAlign = kChannels * kBitsPerSample / 8;
  format.nAvgBytesPerSec = kSampleRate * format.nBlockAlign;

  const DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
  HRESULT hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, kBufferDuration, 0, &format, nullptr);
  if (FAILED(hr)) return fail("audio client did not initialize", hr);
  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  hr = client->SetEventHandle(ready);
  if (FAILED(hr)) return fail("audio event could not be set", hr);
  IAudioCaptureClient* capturer = nullptr;
  hr = client->GetService(kCaptureClient, reinterpret_cast<void**>(&capturer));
  if (FAILED(hr)) return fail("capture service is not available", hr);
  hr = client->Start();
  if (FAILED(hr)) return fail("capture did not start", hr);

  CreateThread(nullptr, 0, watchInput, stop, 0, nullptr);
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  std::fprintf(stderr, "ready\n");
  std::fflush(stderr);

  std::vector<BYTE> silence;
  HANDLE waits[] = {stop, target, ready};
  for (;;) {
    DWORD woke = WaitForMultipleObjects(3, waits, FALSE, INFINITE);
    if (woke == WAIT_OBJECT_0) return 0;
    if (woke == WAIT_OBJECT_0 + 1) return kExitTargetGone;
    UINT32 packet = 0;
    for (;;) {
      hr = capturer->GetNextPacketSize(&packet);
      if (FAILED(hr)) return fail("capture stopped", hr);
      if (!packet) break;
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD state = 0;
      hr = capturer->GetBuffer(&data, &frames, &state, nullptr, nullptr);
      if (FAILED(hr)) return fail("capture buffer failed", hr);
      const DWORD size = frames * format.nBlockAlign;
      const BYTE* bytes = data;
      if (state & AUDCLNT_BUFFERFLAGS_SILENT) {
        silence.assign(size, 0);
        bytes = silence.data();
      }
      const bool sent = writeAll(output, bytes, size);
      capturer->ReleaseBuffer(frames);
      if (!sent) return 0;
    }
  }
}

struct ProcessInfo {
  DWORD parent;
  std::wstring name;
};

std::map<DWORD, ProcessInfo> processTable() {
  std::map<DWORD, ProcessInfo> table;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return table;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  for (BOOL more = Process32FirstW(snapshot, &entry); more; more = Process32NextW(snapshot, &entry)) {
    table[entry.th32ProcessID] = {entry.th32ParentProcessID, entry.szExeFile};
  }
  CloseHandle(snapshot);
  return table;
}

DWORD rootOf(DWORD pid, const std::map<DWORD, ProcessInfo>& table) {
  auto at = table.find(pid);
  while (at != table.end()) {
    auto parent = table.find(at->second.parent);
    if (parent == table.end() || parent->first == at->first || _wcsicmp(parent->second.name.c_str(), at->second.name.c_str()) != 0) break;
    pid = parent->first;
    at = parent;
  }
  return pid;
}

std::string utf8(const std::wstring& text) {
  int size = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string out(size > 0 ? size - 1 : 0, '\0');
  if (size > 1) WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, out.data(), size, nullptr, nullptr);
  return out;
}

std::string jsonText(const std::string& text) {
  std::string out;
  for (char c : text) {
    if (c == '"' || c == '\\') out += '\\';
    if (static_cast<unsigned char>(c) >= 0x20) out += c;
  }
  return out;
}

void collectSessions(IMMDevice* device, const std::map<DWORD, ProcessInfo>& table, std::map<DWORD, bool>& found) {
  IAudioSessionManager2* manager = nullptr;
  if (FAILED(device->Activate(kSessionManager, CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&manager)))) return;
  IAudioSessionEnumerator* sessions = nullptr;
  int count = 0;
  if (SUCCEEDED(manager->GetSessionEnumerator(&sessions)) && SUCCEEDED(sessions->GetCount(&count))) {
    for (int i = 0; i < count; i++) {
      IAudioSessionControl* control = nullptr;
      if (FAILED(sessions->GetSession(i, &control))) continue;
      IAudioSessionControl2* details = nullptr;
      if (SUCCEEDED(control->QueryInterface(kSessionControl2, reinterpret_cast<void**>(&details)))) {
        DWORD pid = 0;
        AudioSessionState state = AudioSessionStateInactive;
        details->GetProcessId(&pid);
        details->GetState(&state);
        if (pid && details->IsSystemSoundsSession() != S_OK) {
          const DWORD root = rootOf(pid, table);
          found[root] = found[root] || state == AudioSessionStateActive;
        }
        details->Release();
      }
      control->Release();
    }
    sessions->Release();
  }
  manager->Release();
}

int list(EDataFlow flow) {
  IMMDeviceEnumerator* devices = nullptr;
  HRESULT hr = CoCreateInstance(kDeviceEnumeratorClass, nullptr, CLSCTX_ALL, kDeviceEnumerator, reinterpret_cast<void**>(&devices));
  if (FAILED(hr)) return fail("audio devices are not available", hr);
  IMMDeviceCollection* endpoints = nullptr;
  hr = devices->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &endpoints);
  if (FAILED(hr)) return fail("audio devices are not available", hr);
  const auto table = processTable();
  std::map<DWORD, bool> found;
  UINT count = 0;
  endpoints->GetCount(&count);
  for (UINT i = 0; i < count; i++) {
    IMMDevice* device = nullptr;
    if (FAILED(endpoints->Item(i, &device))) continue;
    collectSessions(device, table, found);
    device->Release();
  }
  std::string json = "[";
  for (const auto& [pid, active] : found) {
    auto at = table.find(pid);
    if (at == table.end()) continue;
    if (json.size() > 1) json += ",";
    json += "{\"pid\":" + std::to_string(pid) + ",\"name\":\"" + jsonText(utf8(at->second.name)) + "\",\"active\":" + (active ? "true" : "false") + "}";
  }
  json += "]";
  std::fputs(json.c_str(), stdout);
  return 0;
}

}

int main(int argc, char** argv) {
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return kExitFailed;
  std::string command = argc > 1 ? argv[1] : "";
  if (command == "list") return list(eRender);
  if (command == "mic-apps") return list(eCapture);
  if (command == "capture" && argc > 2) {
    const long pid = std::strtol(argv[2], nullptr, 10);
    if (pid > 0) return capture(static_cast<DWORD>(pid));
  }
  std::fputs("usage: app-audio list | mic-apps | capture <pid>\n", stderr);
  return kExitFailed;
}
