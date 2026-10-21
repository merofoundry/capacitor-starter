require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'MeroshellBootstrap'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://merofoundry.app'
  s.author = 'MeroFoundry'
  s.source = { :path => '.' }
  s.source_files = 'ios/Sources/**/*.swift'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
end
