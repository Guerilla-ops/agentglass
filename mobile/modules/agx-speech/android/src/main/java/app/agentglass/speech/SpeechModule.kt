package app.agentglass.speech

import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.util.Locale
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The JS-facing switch for on-device dictation. See src/terminal/speech.ts
 * for why this exists alongside the computer-side transcriber rather than
 * instead of it: Expo Go carries no recogniser at all, and even a build that
 * does is only ever asked to use the ON-DEVICE model — createSpeechRecognizer
 * (the network one) is never called, because a person dictating into this app
 * is doing it from wherever the phone already reads their screen, and audio
 * that leaves the phone for a wrong host would be a mistake nobody could see.
 *
 * Every function here is wrapped so nothing can cross the JS bridge as a
 * crash: a phone that has no on-device model, refuses to grant the
 * microphone, or kills the recognizer mid-utterance should still be a working
 * app with a dictation button that says why, not one that goes down with it.
 * See KeepAliveModule.kt for the same discipline applied to a different
 * always-on-Android surface.
 */
class SpeechModule : Module() {
  private var recognizer: SpeechRecognizer? = null

  /** Torn down from every exit path — stop, cancel, an error the OS reports,
   *  or the module itself going away — so a second start() never finds a
   *  half-alive recognizer still bound to the last utterance. */
  private fun teardown() {
    try {
      recognizer?.destroy()
    } catch (e: Exception) {
      // See the class comment: a recognizer already in a bad state throwing
      // on destroy() is not a reason to take the bridge down with it.
    }
    recognizer = null
  }

  /**
   * The plain-English reason a recognizer error ended the utterance.
   *
   * `ERROR_LANGUAGE_NOT_SUPPORTED` (12) and `ERROR_LANGUAGE_UNAVAILABLE` (13)
   * were only added to the framework in API 33, so this matches them by their
   * raw values rather than by name — the named constants need this module
   * built against compileSdk 33+, and a raw int does not. The SDK_INT guard
   * still gates the sentence, because those codes cannot mean anything else:
   * no recogniser below API 33 emits them.
   */
  private fun messageFor(error: Int, lang: String): String = when (error) {
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "The microphone is not allowed for this app."
    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Nothing was heard."
    else -> if (Build.VERSION.SDK_INT >= 33 && (error == 12 || error == 13)) {
      "No offline speech pack for $lang on this phone — add it in Settings > System > Languages > Speech"
    } else {
      "Speech recognition failed (code $error)."
    }
  }

  private fun textOf(bundle: android.os.Bundle?): String =
    bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""

  override fun definition() = ModuleDefinition {
    Name("AgxSpeech")

    Events("onPartial", "onFinal", "onError", "onEnd")

    Function("available") {
      val context = appContext.reactContext ?: return@Function false
      Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
    }

    // SpeechRecognizer has to be created and driven on the main looper — off
    // it, createOnDeviceSpeechRecognizer and startListening both throw. Every
    // JS caller of start() runs on whatever thread the bridge happens to be
    // on, so the queue is pinned here rather than trusted to the caller.
    AsyncFunction("start") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      try {
        teardown()
        if (Build.VERSION.SDK_INT < 31 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
          sendEvent("onError", mapOf("code" to -1, "message" to "This phone has no on-device speech recognizer, so dictation cannot run here."))
          sendEvent("onEnd", emptyMap<String, Any>())
          return@AsyncFunction null
        }
        val lang = Locale.getDefault().toLanguageTag()
        val engine = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        recognizer = engine
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
          putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
          putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
          putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
          putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }
        engine.setRecognitionListener(object : RecognitionListener {
          override fun onReadyForSpeech(params: android.os.Bundle?) {}
          override fun onBeginningOfSpeech() {}
          override fun onRmsChanged(rmsdB: Float) {}
          override fun onBufferReceived(buffer: ByteArray?) {}
          override fun onEndOfSpeech() {}

          override fun onPartialResults(partialResults: android.os.Bundle?) {
            sendEvent("onPartial", mapOf("text" to textOf(partialResults)))
          }

          override fun onResults(results: android.os.Bundle?) {
            sendEvent("onFinal", mapOf("text" to textOf(results)))
            teardown()
            sendEvent("onEnd", emptyMap<String, Any>())
          }

          override fun onError(error: Int) {
            // 13 is ERROR_LANGUAGE_UNAVAILABLE: the language is supported but
            // its model is not on the phone. Ask the system to fetch it now,
            // on the engine that reported it, before teardown() destroys it —
            // otherwise the pack the message tells the person to add is
            // never even offered. Raw value for the reason messageFor gives.
            if (error == 13 && Build.VERSION.SDK_INT >= 33) {
              try {
                engine.triggerModelDownload(intent)
              } catch (e: Exception) {
                // See the class comment.
              }
            }
            sendEvent("onError", mapOf("code" to error, "message" to messageFor(error, lang)))
            teardown()
            sendEvent("onEnd", emptyMap<String, Any>())
          }

          override fun onEvent(eventType: Int, params: android.os.Bundle?) {}
        })

        engine.startListening(intent)
      } catch (e: Exception) {
        teardown()
        sendEvent("onError", mapOf("code" to -1, "message" to "Speech recognition would not start on this phone."))
        sendEvent("onEnd", emptyMap<String, Any>())
      }
    }.runOnQueue(Queues.MAIN)

    // stop and cancel touch the recognizer, which belongs to the main looper
    // that created it. On the bridge thread they threw inside their own try,
    // the catch swallowed it, and the second press did nothing at all.
    AsyncFunction("stop") {
      try {
        recognizer?.stopListening()
      } catch (e: Exception) {
        // See the class comment.
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("cancel") {
      try {
        recognizer?.cancel()
      } catch (e: Exception) {
        // See the class comment.
      }
      teardown()
    }.runOnQueue(Queues.MAIN)

    // OnDestroy is not promised to run on the main looper; destroy() must.
    OnDestroy {
      Handler(Looper.getMainLooper()).post { teardown() }
    }
  }
}
