package com.deepseek.harness.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Layout shape for the two form factors this app must serve:
 *
 * - **Phone in portrait**: one column. The terminal list and the harness are
 *   full-screen routes; the connection rail is a bottom sheet.
 * - **Tablet in landscape**: two columns. A persistent navigation rail on the
 *   left (terminals + actions) and the harness on the right, so switching
 *   terminals never costs a full-screen navigation.
 *
 * The decision is made from the window's own size, not from
 * `LocalConfiguration.screenWidthDp` alone: on Android 12+ a tablet can run the
 * app in split-screen, where the *window* is phone-width even though the device
 * is not. Keying off the window keeps that case on the one-column layout instead
 * of squeezing a rail into 400dp.
 */
@Immutable
data class FormFactor(
    val isTwoPane: Boolean,
    val compact: Boolean,
    val railWidth: Dp,
    val contentMaxWidth: Dp,
) {
    companion object {
        private const val TWO_PANE_MIN_WIDTH_DP = 720

        @Composable
        fun current(): FormFactor {
            val configuration = LocalConfiguration.current
            val widthDp = configuration.screenWidthDp
            val heightDp = configuration.screenHeightDp
            val twoPane = widthDp >= TWO_PANE_MIN_WIDTH_DP && widthDp > heightDp * 0.9f
            return FormFactor(
                isTwoPane = twoPane,
                compact = widthDp < 600,
                railWidth = if (twoPane) 264.dp else 0.dp,
                // A reading column wider than ~880dp is uncomfortable for chat
                // text, so the harness gets a centred column on very wide tablets.
                contentMaxWidth = 1080.dp,
            )
        }
    }
}
