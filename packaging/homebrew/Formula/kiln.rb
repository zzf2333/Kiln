# Homebrew Formula for the Kiln CLI (`zzf2333/homebrew-tap`).
#
# Pre-release setup:
#   1. Cut a `v<version>` GitHub Release with prebuilt zero-dependency binaries
#      (`kiln-v<version>-darwin-arm64`, `kiln-v<version>-darwin-x64`, `kiln-v<version>-linux-x64`)
#      and `SHA256SUMS`.
#   2. Replace the placeholder `sha256` values below with the real hashes from `SHA256SUMS`.
#   3. Sync this file into `zzf2333/homebrew-tap`.
class Kiln < Formula
  desc "Local-first autonomous developer workbench and kilnd CLI"
  homepage "https://github.com/zzf2333/Kiln"
  version "0.0.2"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/zzf2333/Kiln/releases/download/v#{version}/kiln-v#{version}-darwin-arm64"
      sha256 "0d8308af8ec27f0d4fcdef2fd60d725aeb15635f4a9aef80e96326b90240ae16"
    end

    on_intel do
      url "https://github.com/zzf2333/Kiln/releases/download/v#{version}/kiln-v#{version}-darwin-x64"
      sha256 "8631dc7ae245be1dfa6db3eb7df817bc82109337b2b8429a4a496fa520b0b577"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/zzf2333/Kiln/releases/download/v#{version}/kiln-v#{version}-linux-x64"
      sha256 "65796214a00757f8d19f1dbf6b61742e8c90a48c5f6496a1f785f0785f2fffd0"
    end
  end

  def install
    binary = Dir["kiln-v*"].first
    raise "Expected prebuilt kiln binary in download staging directory" if binary.nil?

    bin.install binary => "kiln"
    bin.install_symlink "kiln" => "kl"
  end

  def caveats
    <<~EOS
      Kiln is distributed as a self-contained single binary (no Node.js runtime required).
      Kiln does not install or enable any background startup service automatically.

      Quick start:
        kiln doctor
        kiln up

      Optional OS startup service (opt-in):
        kiln service install
    EOS
  end

  test do
    assert_match "Kiln CLI", shell_output("#{bin}/kiln --help")
    assert_match version.to_s, shell_output("#{bin}/kiln --version")
    assert_match "Kiln CLI", shell_output("#{bin}/kl --help")
  end
end
