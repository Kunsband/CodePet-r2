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
  $taskbarTestBitmap = $taskbarTestWidget.RenderSurface(227, 48)
  try {
    $taskbarTestPixels = 0
    for ($taskbarTestX = 32; $taskbarTestX -lt 227; $taskbarTestX++) {
      for ($taskbarTestY = 0; $taskbarTestY -lt 48; $taskbarTestY++) {
        $taskbarTestColor = $taskbarTestBitmap.GetPixel($taskbarTestX, $taskbarTestY)
        if ($taskbarTestColor.A -ne 255) { throw 'Non-opaque quota text surface' }
        if ($taskbarTestColor.R -gt 80) { $taskbarTestPixels++ }
      }
    }
    if ($taskbarTestPixels -lt 200) { throw 'Quota text did not render' }
    if ($env:CODEPET_RENDER_TEST_IMAGE) { $taskbarTestBitmap.Save($env:CODEPET_RENDER_TEST_IMAGE) }
    Write-Output "PASS: hidden layered child, native surface submitted, $taskbarTestPixels text pixels"
  } finally { $taskbarTestBitmap.Dispose() }
} finally {
  $taskbarTestWidget.Dispose()
  $taskbarTestParent.Dispose()
}
