# Hidden-parent integration test: never attaches to Explorer or shows a window.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot '../src/windows-taskbar-host.cs')))
$taskbarTestParent = New-Object System.Windows.Forms.Form
$taskbarTestParent.ClientSize = New-Object System.Drawing.Size(1920, 48)
$taskbarTestWidget = New-Object CodePetTaskbar($taskbarTestParent.Handle)
try {
  $taskbarTestHandle = $taskbarTestWidget.Handle
  $taskbarTestState = New-Object CodePetTaskbar+State
  $taskbarTestState.icon = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot '../build/icon.png')))
  $taskbarTestState.rows = @(
    (New-Object CodePetTaskbar+Row -Property @{ label = 'Codex'; remainingPercent = 77 }),
    (New-Object CodePetTaskbar+Row -Property @{ label = 'AGY'; remainingPercent = 100 }),
    (New-Object CodePetTaskbar+Row -Property @{ label = 'Claude'; remainingPercent = 22 })
  )
  $taskbarTestWidget.UpdateState($taskbarTestState)
  if (-not $taskbarTestWidget.Rendered) { throw "UpdateLayeredWindow failed: $($taskbarTestWidget.RenderError)" }
  if ($taskbarTestParent.Visible) { throw 'Test parent must remain hidden' }
  $taskbarTestTotal = 0
  foreach ($taskbarTestLight in @($false, $true)) {
    $taskbarTestWidget.LightTheme = $taskbarTestLight
    $taskbarTestBitmap = $taskbarTestWidget.RenderSurface(198, 48)
    try {
      $taskbarTestPixels = 0
      for ($taskbarTestX = 0; $taskbarTestX -lt 198; $taskbarTestX++) {
        for ($taskbarTestY = 0; $taskbarTestY -lt 48; $taskbarTestY++) {
          $taskbarTestColor = $taskbarTestBitmap.GetPixel($taskbarTestX, $taskbarTestY)
          # Every pixel keeps a little alpha so the whole widget stays clickable.
          if ($taskbarTestColor.A -lt 1) { throw 'Click-through hole in quota surface' }
          if ($taskbarTestX -ge 36 -and $taskbarTestColor.A -gt 120) { $taskbarTestPixels++ }
        }
      }
      if ($taskbarTestPixels -lt 150) { throw "Quota text did not render (light=$taskbarTestLight)" }
      $taskbarTestTotal += $taskbarTestPixels
      if ($env:CODEPET_RENDER_TEST_IMAGE) {
        $taskbarTestBitmap.Save($env:CODEPET_RENDER_TEST_IMAGE.Replace('.png', $(if ($taskbarTestLight) { '-light.png' } else { '-dark.png' })))
      }
    } finally { $taskbarTestBitmap.Dispose() }
  }
  Write-Output "PASS: hidden layered child, native surface submitted, $taskbarTestTotal text pixels"
} finally {
  $taskbarTestWidget.Dispose()
  $taskbarTestParent.Dispose()
}
