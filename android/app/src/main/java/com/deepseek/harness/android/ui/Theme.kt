package com.deepseek.harness.android.ui

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

/**
 * One dark/light palette for both form factors.
 *
 * Deliberately not dynamic colour: the harness UI inside the WebView has its own
 * appearance, and a phone-tinted shell around an un-tinted page reads as two
 * different apps. Neutral greys match the harness surface in each theme.
 */
private val LightScheme = lightColorScheme(
    primary = Color(0xFF2B62D9),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDCE6FF),
    onPrimaryContainer = Color(0xFF0B2B62),
    secondary = Color(0xFF4F5B70),
    surface = Color(0xFFFBFBFD),
    onSurface = Color(0xFF16181D),
    surfaceVariant = Color(0xFFEDEFF4),
    onSurfaceVariant = Color(0xFF454B57),
    background = Color(0xFFF4F5F8),
    onBackground = Color(0xFF16181D),
    outline = Color(0xFFC7CBD4),
    error = Color(0xFFB3261E),
    onError = Color.White,
)

private val DarkScheme = darkColorScheme(
    primary = Color(0xFF8FB4FF),
    onPrimary = Color(0xFF07275E),
    primaryContainer = Color(0xFF1B3A75),
    onPrimaryContainer = Color(0xFFDCE6FF),
    secondary = Color(0xFFB9C2D0),
    surface = Color(0xFF15161A),
    onSurface = Color(0xFFE6E8EE),
    surfaceVariant = Color(0xFF23252B),
    onSurfaceVariant = Color(0xFFB3B9C6),
    background = Color(0xFF101115),
    onBackground = Color(0xFFE6E8EE),
    outline = Color(0xFF3B3F49),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
)

private val AppTypography = Typography(
    titleLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 22.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 17.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.Default, fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.Default, fontSize = 14.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 14.sp),
    labelMedium = TextStyle(fontFamily = FontFamily.Default, fontSize = 12.sp),
)

@Composable
fun DshTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }
    MaterialTheme(
        colorScheme = if (darkTheme) DarkScheme else LightScheme,
        typography = AppTypography,
        content = content,
    )
}
