--[[
	Inbetween companion plugin for Roblox Studio.

	Install: copy this file into your local Plugins folder and restart Studio
	  Windows: %LOCALAPPDATA%\Roblox\Plugins
	  macOS:   ~/Documents/Roblox/Plugins
	(Inbetween > Settings > "Install plugin" does this for you.)

	What it does, with the Inbetween app open on the same computer:
	  Send Rig          Serialises the selected rig (Motor6D joints, AnimationConstraints and
	                    skinned-mesh Bones) and sends it to Inbetween as a custom rig.
	  Import Animation  Fetches the clip that is open in Inbetween and builds a KeyframeSequence
	                    under the selected rig's AnimSaves folder, ready for the Animation Editor.
	  Preview           Plays that KeyframeSequence on the selected rig in Studio.

	It talks only to http://127.0.0.1:<port> (default 47821). Change the port in the widget if
	Inbetween's Settings shows a different one.
]]

local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local ServerStorage = game:GetService("ServerStorage")

local DEFAULT_PORT = 47821
local SETTING_PORT = "InbetweenPort"

local toolbar = plugin:CreateToolbar("Inbetween")
local sendButton = toolbar:CreateButton("InbetweenSendRig", "Send the selected rig to Inbetween", "", "Send Rig")
local importButton = toolbar:CreateButton("InbetweenImport", "Import the open Inbetween clip as a KeyframeSequence", "", "Import Animation")
local previewButton = toolbar:CreateButton("InbetweenPreview", "Play the last imported animation on the selected rig", "", "Preview")
local panelButton = toolbar:CreateButton("InbetweenPanel", "Show the Inbetween panel", "", "Panel")
sendButton.ClickableWhenViewportHidden = true
importButton.ClickableWhenViewportHidden = true
previewButton.ClickableWhenViewportHidden = true
panelButton.ClickableWhenViewportHidden = true

-- ---------------------------------------------------------------- panel

local widget = plugin:CreateDockWidgetPluginGuiAsync(
	"InbetweenPanel",
	DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 300, 190, 240, 150)
)
widget.Title = "Inbetween"

local root = Instance.new("Frame")
root.Size = UDim2.fromScale(1, 1)
root.BorderSizePixel = 0
root.Parent = widget

local layout = Instance.new("UIListLayout")
layout.Padding = UDim.new(0, 8)
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Parent = root

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 10)
padding.PaddingLeft = UDim.new(0, 10)
padding.PaddingRight = UDim.new(0, 10)
padding.Parent = root

local function label(text: string, order: number, height: number?): TextLabel
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.Size = UDim2.new(1, 0, 0, height or 18)
	l.Font = Enum.Font.SourceSans
	l.TextSize = 15
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.TextYAlignment = Enum.TextYAlignment.Top
	l.TextWrapped = true
	l.Text = text
	l.LayoutOrder = order
	l.Parent = root
	return l
end

local portLabel = label("Inbetween port", 1)
local portBox = Instance.new("TextBox")
portBox.Size = UDim2.new(1, 0, 0, 24)
portBox.Font = Enum.Font.SourceSans
portBox.TextSize = 15
portBox.ClearTextOnFocus = false
portBox.Text = tostring(plugin:GetSetting(SETTING_PORT) or DEFAULT_PORT)
portBox.LayoutOrder = 2
portBox.Parent = root
local statusLabel = label("Select a rig, then use the toolbar buttons.", 3, 80)

local function applyTheme()
	local theme = settings().Studio.Theme
	root.BackgroundColor3 = theme:GetColor(Enum.StudioStyleGuideColor.MainBackground)
	local text = theme:GetColor(Enum.StudioStyleGuideColor.MainText)
	portLabel.TextColor3 = text
	statusLabel.TextColor3 = text
	portBox.TextColor3 = text
	portBox.BackgroundColor3 = theme:GetColor(Enum.StudioStyleGuideColor.InputFieldBackground)
	portBox.BorderColor3 = theme:GetColor(Enum.StudioStyleGuideColor.InputFieldBorder)
end
applyTheme()
settings().Studio.ThemeChanged:Connect(applyTheme)

local function status(text: string, isError: boolean?)
	statusLabel.Text = text
	if isError then
		warn("[Inbetween] " .. text)
	else
		print("[Inbetween] " .. text)
	end
end

local function getPort(): number
	local n = tonumber(portBox.Text)
	if n and n >= 1 and n <= 65535 then
		return math.floor(n)
	end
	return DEFAULT_PORT
end

portBox.FocusLost:Connect(function()
	local port = getPort()
	portBox.Text = tostring(port)
	plugin:SetSetting(SETTING_PORT, port)
end)

panelButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

-- ---------------------------------------------------------------- http

local function request(method: string, path: string, body: string?): (boolean, any)
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = string.format("http://127.0.0.1:%d%s", getPort(), path),
			Method = method,
			Headers = {
				["Content-Type"] = "application/json",
				["X-Inbetween-Studio"] = "1",
			},
			Body = body,
		})
	end)
	if not ok then
		return false, "Could not reach Inbetween on port " .. getPort() .. ". Is the app open? (" .. tostring(response) .. ")"
	end
	local decodedOk, decoded = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not decodedOk then
		return false, "Inbetween sent an unreadable reply (HTTP " .. tostring(response.StatusCode) .. ")."
	end
	if not response.Success or decoded.ok == false then
		return false, decoded.error or ("Inbetween replied with HTTP " .. tostring(response.StatusCode))
	end
	return true, decoded
end

-- ---------------------------------------------------------------- rig serialisation

local function components(cf: CFrame): { number }
	return { cf:GetComponents() }
end

local function selectedRig(): Model?
	for _, item in Selection:Get() do
		local current: Instance? = item
		while current and current ~= workspace do
			if current:IsA("Model") then
				-- Prefer the outermost model that actually has joints or a humanoid.
				local candidate = current
				local parent = current.Parent
				while parent and parent:IsA("Model") and parent ~= workspace do
					candidate = parent
					parent = parent.Parent
				end
				return candidate :: Model
			end
			current = current.Parent
		end
	end
	return nil
end

local function serializeRig(model: Model): ({ [string]: any }?, string?)
	local parts = {}
	local partNames: { [string]: boolean } = {}
	local duplicates = {}
	local joints = {}
	local bones = {}
	local jointed: { [Instance]: boolean } = {}

	for _, d in model:GetDescendants() do
		if d:IsA("Motor6D") then
			if d.Part0 and d.Part1 then
				table.insert(joints, {
					name = d.Name,
					type = "Motor6D",
					part0 = d.Part0.Name,
					part1 = d.Part1.Name,
					c0 = components(d.C0),
					c1 = components(d.C1),
				})
				jointed[d.Part0] = true
				jointed[d.Part1] = true
			end
		elseif d.ClassName == "AnimationConstraint" then
			-- Newer avatars use AnimationConstraints between attachments instead of Motor6Ds.
			local a0 = (d :: any).Attachment0
			local a1 = (d :: any).Attachment1
			if a0 and a1 and a0.Parent and a1.Parent and a0.Parent:IsA("BasePart") and a1.Parent:IsA("BasePart") then
				table.insert(joints, {
					name = d.Name,
					type = "AnimationConstraint",
					part0 = a0.Parent.Name,
					part1 = a1.Parent.Name,
					c0 = components(a0.CFrame),
					c1 = components(a1.CFrame),
				})
				jointed[a0.Parent] = true
				jointed[a1.Parent] = true
			end
		end
	end

	for _, d in model:GetDescendants() do
		if d:IsA("BasePart") then
			local hasBones = d:FindFirstChildWhichIsA("Bone", true) ~= nil
			if jointed[d] or hasBones or #joints == 0 then
				if partNames[d.Name] then
					table.insert(duplicates, d.Name)
				end
				partNames[d.Name] = true
				table.insert(parts, { name = d.Name, size = { d.Size.X, d.Size.Y, d.Size.Z }, cframe = components(d.CFrame) })
			end
		end
	end

	for _, d in model:GetDescendants() do
		if d:IsA("Bone") and d.Parent then
			if partNames[d.Name] then
				table.insert(duplicates, d.Name)
			end
			partNames[d.Name] = true
			-- Bone.CFrame is the rest transform relative to the parent bone or part.
			table.insert(bones, { name = d.Name, parent = d.Parent.Name, cframe = components(d.CFrame) })
		end
	end

	if #parts == 0 then
		return nil, "\"" .. model.Name .. "\" has no parts to animate."
	end
	if #duplicates > 0 then
		return nil, "Parts or bones share a name (" .. table.concat(duplicates, ", ") .. "). Animation needs unique names; rename them and try again."
	end

	local humanoid = model:FindFirstChildOfClass("Humanoid")
	local rootPart = (humanoid and humanoid.RootPart) or model.PrimaryPart or model:FindFirstChild("HumanoidRootPart")
	return {
		format = "inbetween-roblox-rig",
		version = 1,
		name = model.Name,
		rootPart = if rootPart then rootPart.Name else parts[1].name,
		hipHeight = if humanoid then humanoid.HipHeight else nil,
		parts = parts,
		joints = joints,
		bones = bones,
	}, nil
end

sendButton.Click:Connect(function()
	local model = selectedRig()
	if not model then
		status("Select a rig (a Model with Motor6D joints or Bones) first.", true)
		return
	end
	local data, problem = serializeRig(model)
	if not data then
		status(problem or "Could not read the rig.", true)
		return
	end
	local json = HttpService:JSONEncode(data)
	local ok, result = request("POST", "/studio/rig", json)
	if ok then
		status(string.format("Sent \"%s\" to Inbetween (%d bones).", model.Name, result.bones or 0))
	else
		-- Offline fallback: leave the JSON somewhere it can be copied into a file by hand.
		local holder = ServerStorage:FindFirstChild("InbetweenRigJSON") or Instance.new("StringValue")
		holder.Name = "InbetweenRigJSON"
		holder.Value = json
		holder.Parent = ServerStorage
		status(tostring(result) .. " The rig JSON was saved to ServerStorage.InbetweenRigJSON; copy its Value into a .json file and use File > Import Rig in Inbetween.", true)
	end
end)

-- ---------------------------------------------------------------- animation import

local function enumByValue(enum: Enum, value: number, fallback: EnumItem): EnumItem
	for _, item in enum:GetEnumItems() do
		if item.Value == value then
			return item
		end
	end
	return fallback
end

local function buildPose(data: any): Pose
	local pose = Instance.new("Pose")
	pose.Name = data.name
	pose.CFrame = CFrame.new(table.unpack(data.cframe))
	pose.Weight = data.weight
	pose.EasingStyle = enumByValue(Enum.PoseEasingStyle, data.easingStyle, Enum.PoseEasingStyle.Linear) :: Enum.PoseEasingStyle
	pose.EasingDirection = enumByValue(Enum.PoseEasingDirection, data.easingDirection, Enum.PoseEasingDirection.In) :: Enum.PoseEasingDirection
	for _, child in data.children do
		pose:AddSubPose(buildPose(child))
	end
	return pose
end

local function buildSequence(data: any): KeyframeSequence
	local sequence = Instance.new("KeyframeSequence")
	sequence.Name = data.name
	sequence.Loop = data.loop
	sequence.Priority = enumByValue(Enum.AnimationPriority, data.priority, Enum.AnimationPriority.Action) :: Enum.AnimationPriority
	if data.authoredHipHeight then
		sequence.AuthoredHipHeight = data.authoredHipHeight
	end
	for _, kf in data.keyframes do
		local keyframe = Instance.new("Keyframe")
		keyframe.Name = kf.name
		keyframe.Time = kf.time
		for _, pose in kf.poses do
			keyframe:AddPose(buildPose(pose))
		end
		for _, marker in kf.markers do
			local m = Instance.new("KeyframeMarker")
			m.Name = marker.name
			m.Value = marker.value
			keyframe:AddMarker(m)
		end
		keyframe.Parent = sequence
	end
	return sequence
end

local lastSequence: KeyframeSequence? = nil

importButton.Click:Connect(function()
	local ok, result = request("GET", "/studio/animation")
	if not ok then
		status(tostring(result), true)
		return
	end
	local model = selectedRig()
	local recording = ChangeHistoryService:TryBeginRecording("Import Inbetween animation")
	local sequence = buildSequence(result.sequence)
	local container: Instance
	if model then
		-- The Animation Editor looks for saved KeyframeSequences in the rig's AnimSaves folder.
		container = model:FindFirstChild("AnimSaves") or Instance.new("Model")
		container.Name = "AnimSaves"
		container.Parent = model
	else
		container = ServerStorage
	end
	local existing = container:FindFirstChild(sequence.Name)
	if existing and existing:IsA("KeyframeSequence") then
		existing:Destroy()
	end
	sequence.Parent = container
	lastSequence = sequence
	Selection:Set({ sequence })
	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end
	status(string.format(
		"Imported \"%s\" (%d keyframes) into %s. Open the Animation Editor on the rig to publish it.",
		sequence.Name, #sequence:GetKeyframes(), container:GetFullName()
	))
end)

-- ---------------------------------------------------------------- preview

local activeTrack: AnimationTrack? = nil

previewButton.Click:Connect(function()
	if activeTrack then
		activeTrack:Stop(0)
		activeTrack = nil
		status("Preview stopped.")
		return
	end
	local model = selectedRig()
	local sequence = lastSequence
	for _, item in Selection:Get() do
		if item:IsA("KeyframeSequence") then
			sequence = item
		end
	end
	if not sequence then
		status("Import an animation first, or select a KeyframeSequence.", true)
		return
	end
	if not model then
		local holder = sequence:FindFirstAncestorWhichIsA("Model")
		model = if holder and holder.Name == "AnimSaves" then holder.Parent :: Model else holder
	end
	if not model then
		status("Select the rig to preview on.", true)
		return
	end
	local controller: Instance? = model:FindFirstChildOfClass("Humanoid") or model:FindFirstChildOfClass("AnimationController")
	if not controller then
		controller = Instance.new("AnimationController")
		controller.Parent = model
	end
	local animator = (controller :: Instance):FindFirstChildOfClass("Animator")
	if not animator then
		animator = Instance.new("Animator")
		animator.Parent = controller
	end
	local ok, problem = pcall(function()
		-- Temporary local id; valid only in this Studio session.
		local provider = game:GetService("KeyframeSequenceProvider")
		local animation = Instance.new("Animation")
		animation.AnimationId = provider:RegisterKeyframeSequence(sequence)
		local track = (animator :: Animator):LoadAnimation(animation)
		track:Play(0)
		activeTrack = track
		track.Stopped:Connect(function()
			if activeTrack == track then
				activeTrack = nil
			end
		end)
	end)
	if ok then
		status("Previewing \"" .. sequence.Name .. "\". Click Preview again to stop. (Animations only play in Studio while the Animation Editor is closed.)")
	else
		status("Could not preview: " .. tostring(problem), true)
	end
end)
