# Cameras and visibility

Define each shot by time range, shot size, position/path, look target, FOV and intended subject information. Camera and target are functions of time. Use arc-length sampling and easing as appropriate; do not replace a requested steady orbit with stop-and-go movement.

Compute tracking offsets from subject position and path direction. A slightly delayed sampled target can express camera lag without stateful integration. Do not attach the camera to a bobbing body part. Over-the-shoulder framing needs a foreground shoulder and a clear opposite subject, not a foreground head filling the frame.

Requested wide, medium, hand and head-and-shoulders shots must differ visibly. A wide shot may use small subjects if spatial relationships remain readable. A close-up must show the relevant part rather than the whole body. There is no universal one-third-frame-height minimum for every shot.

## Three separate checks

1. **Camera collision:** sample the camera and near plane against walls, roofs, pillars and vehicles, using raycasts or bounding volumes when useful. Reducing the near distance does not fix a camera inside a wall.
2. **Subject occlusion:** trace sightlines to head, chest and key hands. A collision-free camera can still film a roof or have a foreground shoulder hide the important prop.
3. **Composition and cropping:** project key points or bounds into the image. Assess occlusion, subject size and cropping separately; use projection rather than repeatedly guessing FOV.

Sample requested moments, shot boundaries and the fastest movement. Inspect frames on both sides of cuts, expanding to action strips when necessary. For a full product orbit, check accumulated angle and endpoints; two similar images of a symmetric object do not prove a complete revolution.

Use continuous position and orientation curves within shots. Interpolate yaw across ±PI by the short route. Hard cuts change cameras without resetting world time or teleporting actors and props for composition.
